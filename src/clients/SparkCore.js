/*
*   Copyright (c) 2015 Particle Industries, Inc.  All rights reserved.
*
*   This program is free software; you can redistribute it and/or
*   modify it under the terms of the GNU Lesser General Public
*   License as published by the Free Software Foundation, either
*   version 3 of the License, or (at your option) any later version.
*
*   This program is distributed in the hope that it will be useful,
*   but WITHOUT ANY WARRANTY; without even the implied warranty of
*   MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
*   Lesser General Public License for more details.
*
*   You should have received a copy of the GNU Lesser General Public
*   License along with this program; if not, see <http://www.gnu.org/licenses/>.
*
* @flow
*
*/


import EventEmitter from 'events';
import moment from 'moment';
import fs from 'fs';

import {Message} from 'h5.coap';

import settings from '../settings';
import CryptoLib from '../lib/ICrypto';
import Messages from '../lib/Messages';
import Handshake from '../lib/Handshake';
import utilities from '../lib/utilities.js';
import Flasher from '../lib/Flasher';
import logger from '../lib/logger.js';
import {BufferReader} from 'h5.buffers';
import nullthrows from 'nullthrows';



//Hello — sent first by Core then by Server immediately after handshake, never again
//Ignored — sent by either side to respond to a message with a bad counter value. The receiver of an Ignored message can optionally decide to resend a previous message if the indicated bad counter value matches a recently sent message.

//package flasher
//Chunk — sent by Server to send chunks of a firmware binary to Core
//ChunkReceived — sent by Core to respond to each chunk, indicating the CRC of the received chunk data.  if Server receives CRC that does not match the chunk just sent, that chunk is sent again
//UpdateBegin — sent by Server to initiate an OTA firmware update
//UpdateReady — sent by Core to indicate readiness to receive firmware chunks
//UpdateDone — sent by Server to indicate all firmware chunks have been sent

//FunctionCall — sent by Server to tell Core to call a user-exposed function
//FunctionReturn — sent by Core in response to FunctionCall to indicate return value. void functions will not send this message
//VariableRequest — sent by Server to request the value of a user-exposed variable
//VariableValue — sent by Core in response to VariableRequest to indicate the value

//Event — sent by Core to initiate a Server Sent Event and optionally an HTTP callback to a 3rd party
//KeyChange — sent by Server to change the AES credentials

const COUNTER_MAX = settings.message_counter_max;
const KEEP_ALIVE_TIMEOUT = settings.keepaliveTimeout;
const SOCKET_TIMEOUT = settings.socketTimeout;
const MAX_BINARY_SIZE = 108000; // According to the forums this is the max size.

/**
 * Implementation of the Particle messaging protocol
 * @SparkCore
 */
class SparkCore extends EventEmitter {
  _socket: Socket;
  _disconnectCounter: number = 0;
  _tokens: Object = {};

  constructor(socket) {
    super();

    this._socket = socket;
  }

  /**
   * configure our socket and start the handshake
   */
  startupProtocol = (): void => {
    this._socket.setNoDelay(true);
    this._socket.setKeepAlive(true, KEEP_ALIVE_TIMEOUT); //every 15 second(s)
    this._socket.setTimeout(SOCKET_TIMEOUT);

    this._socket.on(
      'error',
      error => this.disconnect(`socket error ${error}`),
    );
    this._socket.on(
      'close',
      error => this.disconnect(`socket close ${error}`),
    );
    this._socket.on(
      'timeout',
      error => this.disconnect(`socket timeout ${error}`),
    );

    this.handshake();
  };

  handshake = async (): void => {
    var handshake = new Handshake(this);

    //when the handshake is done, we can expect two stream properties, '_decipherStream' and '_cipherStream'
    try{
      const {
        coreId,
        cipherStream,
        decipherStream,
        handshakeBuffer,
        pendingBuffers,
        sessionKey,
      } = await handshake.start();
      this._coreId = coreId;

      this._getHello(handshakeBuffer);
      this._sendHello(cipherStream, decipherStream);

      this.ready();

      pendingBuffers.map(data => this.routeMessage(data));
      this._decipherStream.on('readable', () => {
        const chunk = ((decipherStream.read(): any): Buffer);
        if (!chunk) {
          return;
        }
        this.routeMessage(chunk);
      });
    } catch (exception) {
      this.disconnect(exception);
    }
  };

  _getHello = (chunk: Buffer): void => {
    var message = Messages.unwrap(chunk);
    if (!message) {
      throw 'failed to parse hello';
    }

    this._recieveCounter = message.getId();

    try {
      const payload = message.getPayload();
      if (payload.length <= 0) {
        return;
      }

      var payloadBuffer = new BufferReader(payload);
      this._particleProductId = payloadBuffer.shiftUInt16();
      this._productFirmwareVersion = payloadBuffer.shiftUInt16();
      this._platformId = payloadBuffer.shiftUInt16();
    } catch (exception) {
      logger.log('error while parsing hello payload ', exception);
    }
  };

  _sendHello = (cipherStream: Duplex, decipherStream: Duplex): void => {
      this._cipherStream = cipherStream;
      this._decipherStream = decipherStream

      //client will set the counter property on the message
      this._sendCounter = CryptoLib.getRandomUINT16();
      this.sendMessage('Hello', {}, null, null);
  };

  ready = (): void => {
      this._connectionStartTime = new Date();

      logger.log(
        'on ready',
        {
          coreID: this.getHexCoreID(),
          ip: this.getRemoteIPAddress(),
          product_id: this._particleProductId,
          firmware_version: this._productFirmwareVersion,
          _platformId: this._platformId,
          cache_key: this._connectionKey,
        },
      );

      //catch any and all describe responses
      this.on(
        'msg_describereturn',
        message => this._onDescribeReturn(message),
      );
      this.on(
        'msg_PrivateEvent'.toLowerCase(),
        message => this._onCorePrivateEvent(message),
      );
      this.on(
        'msg_PublicEvent'.toLowerCase(),
        message => this._onCorePublicEvent(message),
      );
      this.on(
        'msg_Subscribe'.toLowerCase(),
        message => this.onCorePublicSubscribe(message),
      );
      this.on(
        'msg_GetTime'.toLowerCase(),
        message => this._onCoreGetTime(message),
      );

      this.emit('ready');
  };


  /**
   * @param sender
   * @param response
   */
  sendApiResponse = (sender, response): void => {
    try {
      this.emit(sender, sender, response);
    } catch (exception) {
      logger.error('Error during response ', exception);
    }
  };


  /**
   * Handles messages coming from the API over our message queue service
   */
  onApiMessage = (sender, message: Message): void => {
    //if we're not the owner, then the socket is busy
    const isBusy = !this._isSocketAvailable(null);
    if (isBusy) {
      this.sendApiResponse(
        sender,
        { error: 'This core is locked during the flashing process.' },
      );
      return;
    }

    switch (message.cmd) {
      case 'Describe': {
        if (settings.logApiMessages) {
          logger.log('Describe', { coreID: this.coreID });
        }
        when(
          this._ensureWeHaveIntrospectionData()
        ).then(
          () => this.sendApiResponse(
            sender,
            {
              cmd: 'DescribeReturn',
              firmware_version: this._productFirmwareVersion,
              name: message.name,
              product_id: this._particleProductId,
              state: this._deviceFunctionState,
            },
          ),
          message => this.sendApiResponse(
            sender,
            {
              cmd: 'DescribeReturn',
              err: 'Error, no device state',
              name: message.name,
            },
          ),
        );
        break;
      }

      case 'GetVar': {
        if (settings.logApiMessages) {
          logger.log('GetVar', { coreID: this.coreID });
        }
        this._getVariable(
          message.name,
          message.type,
          (value, buffer, error) => {
            this.sendApiResponse(
              sender,
              {
                cmd: 'VarReturn',
                error: error,
                name: message.name,
                result: value,
              },
            );
          },
        );
        break;
      }
      case 'SetVar': {
        if (settings.logApiMessages) {
          logger.log('SetVar', { coreID: this.coreID });
        }
        this._setVariable(
          message.name,
          message.value,
          (resp) => this.sendApiResponse(
            sender,
            {
              cmd: 'VarReturn',
              name: message.name,
              result: resp.getPayload().toString(),
            },
          ),
        );
        break;
      }

      case 'CallFn': {
        if (settings.logApiMessages) {
          logger.log('FunCall', { coreID: this.coreID });
        }
        this._callFunction(
          message.name,
          message.args,
          (functionResult) => this.sendApiResponse(
            sender,
            {
                cmd: 'FnReturn',
                error: functionResult.Error,
                name: message.name,
                result: functionResult,
            },
          ),
        );
        break;
      }

      case 'UFlash': {
        if (settings.logApiMessages) {
          logger.log('FlashCore', { coreID: this.coreID });
        }

        this.flashCore(message.args.data, sender);
        break;
      }

      case 'FlashKnown': {
        if (settings.logApiMessages) {
          logger.log(
            'FlashKnown',
            { app: message.app, coreID: this.coreID },
          );
        }

        // Responsibility for sanitizing app names lies with API Service
        // This includes only allowing apps whose binaries are deployed and thus exist
        fs.readFile(
          `known_firmware/${message.app}_${settings.environment}.bin`,
          (error, buffer) => {
            if (!error) {
              this.flashCore(buffer, buffer);
              return;
            }

            logger.log(
              'Error flashing known firmware',
              { coreID: this.coreID, error },
            );
            this.sendApiResponse(
              sender,
              {
                cmd: 'Event',
                message: 'Update failed - ' + JSON.stringify(error),
                name: 'Update',
              },
            );
          },
        );
        break;
      }

      case 'RaiseHand': {
        if (settings.logApiMessages) {
          logger.log('SignalCore', { coreID: this.coreID });
        }

        var showSignal = message.args && message.args.signal;
        this._raiseYourHand(
          showSignal,
          (result) => this.sendApiResponse(
            sender,
            {cmd: 'RaiseHandReturn', result},
          ),
        );
        break;
      }

      case 'Ping': {
        if (settings.logApiMessages) {
          logger.log('Pinged, replying', { coreID: this.coreID });
        }

        this.sendApiResponse(
          sender,
          {
            cmd: 'Pong',
            lastPing: this._lastCorePing,
            online: this._socket !== null,
          },
        );
        break;
      }

      default: {
        this.sendApiResponse(sender, {error: 'unknown message' });
      }
    }
  };

  /**
   * Deals with messages coming from the core over our secure connection
   * @param data
   */
  routeMessage = (data: Buffer): void => {
      const message = Messages.unwrap(data);
      if (!message) {
        logger.error(
          'routeMessage got a NULL coap message ',
          { coreID: this.getHexCoreID() },
        );
        return;
      }

      this._lastMessageTime = new Date();

      //should be adequate
      const messageCode = message.getCode();
      let requestType = '';
      if (
        messageCode > Message.Code.EMPTY &&
        messageCode <= Message.Code.DELETE
      ) {
        //probably a request
        requestType = Messages.getRequestType(message);
      }

      if (!requestType) {
        requestType = this._getResponseType(message.getTokenString());
      }

      console.log(
        'Device got message of type ',
        requestType,
        ' with token ',
        message.getTokenString(),
        ' ',
        Messages.getRequestType(message),
      );

      if (message.isAcknowledgement()) {
        if (!requestType) {
            //no type, can't route it.
            requestType = 'PingAck';
        }
        this.emit(('msg_' + requestType).toLowerCase(), message);
        return;
      }


      this._incrementRecieveCounter();
      if (message.isEmpty() && message.isConfirmable()) {
        this._lastCorePing = new Date();
        //var delta = (this._lastCorePing - this._connectionStartTime) / 1000.0;
        //logger.log('core ping @ ', delta, ' seconds ', { coreID: this.getHexCoreID() });
        this.sendReply('PingAck', message.getId());
        return;
      }

      if (!message || message.getId() !== this._recieveCounter) {
        logger.log(
          'got counter ',
          message.getId(),
          ' expecting ',
          this._recieveCounter,
          { coreID: this.getHexCoreID() },
        );

        if (requestType === 'Ignored') {
          //don't ignore an ignore...
          this.disconnect('Got an Ignore');
          return;
        }

        //this.sendMessage('Ignored', null, {}, null, null);
        this.disconnect('Bad Counter');
        return;
      }

      this.emit(('msg_' + requestType).toLowerCase(), message);
  };

  sendReply = (name, id, data, token, onError, requester): void => {
    if (!this._isSocketAvailable(requester, name)) {
      onError && onError('This client has an exclusive lock.');
      return;
    }

    //if my reply is an acknowledgement to a confirmable message
    //then I need to re-use the message id...

    //set our counter
    if (id < 0) {
      this._incrementSendCounter();
      id = this._sendCounter;
    }


    const message = Messages.wrap(name, id, null, data, token, null);
    if (!this._cipherStream) {
        logger.error(
          'Device - sendReply before READY',
          { coreID: this.getHexCoreID() },
        );
        return;
    }
    this._cipherStream.write(message, null, null);
  };


  sendMessage = (name, params, data, onResponse, onError, requester): void => {
    if (!this._isSocketAvailable(requester, name)) {
      onError && onError('This client has an exclusive lock.');
      return false;
    }

    //increment our counter
    this._incrementSendCounter();

    let token = null;
    if (!Messages.isNonTypeMessage(name)) {
      token = this._getNextToken()
      this._useToken(name, token);

      return;
    }

    const message = Messages.wrap(
      name,
      this._sendCounter,
      params,
      data,
      token,
      onError,
    );

    if (message === null) {
      logger.error('Could not wrap message', name, params, data);
    }

    if (!this._cipherStream) {
      logger.error(
        'Client - sendMessage before READY',
        { coreID: this.getHexCoreID() },
      );
      return;
    }

    this._cipherStream.write(message, null, null);

    return token || 0;
  };

  /**
   * Adds a listener to our secure message stream
   * @param name the message type we're waiting on
   * @param uri - a particular function / variable?
   * @param token - what message does this go with? (should come from sendMessage)
   * @param callback what we should call when we're done
   * @param [once] whether or not we should keep the listener after we've had a match
   */
  listenFor = (
    name,
    uri,
    token,
    callback,
    runOnce,
  ): (message: Object) => void => {
    const tokenHex = token ? utilities.toHexString(token) : null;
    const beVerbose = settings.showVerboseDeviceLogs;

    //TODO: failWatch?  What kind of timeout do we want here?

    //adds a one time event
    const eventName = 'msg_' + name.toLowerCase(),
    handler = (message: Message): void => {
      if (uri && message.getUriPath().indexOf(uri) !== 0) {
        if (beVerbose) {
          logger.log(
            'uri filter did not match',
            uri,
            msg.getUriPath(),
            { coreID: this.getHexCoreID() },
          );
        }
        return;
      }

      if (tokenHex && tokenHex !== message.getTokenString()) {
        if (beVerbose) {
          logger.log(
            'Tokens did not match ',
             tokenHex,
             message.getTokenString(),
             { coreID: this.getHexCoreID() },
           );
        }
        return;
      }

      if (runOnce) {
        this.removeListener(eventName, handler);
      }

      process.nextTick((): void => {
        try {
            if (beVerbose) {
              logger.log(
                'heard ',
                name,
                { coreID: this.coreID },
              );
            }
            callback(message);
        } catch (exception) {
          logger.error(
            `listenFor ${name} - caught error: `,
            exception,
            exception.stack,
            { coreID: this.getHexCoreID() },
          );
        }
      });
    };

    //logger.log('listening for ', eventName);
    this.on(eventName, handler);

    return handler;
  };

  _increment = (counter: number): number => {
    counter++;
    return counter < COUNTER_MAX
      ? counter
      : 0;
  };

  /**
   * Gets or wraps
   * @returns {null}
   */
  _incrementSendCounter = (): void => {
    this._sendCounter = this._increment(this._sendCounter);
  };

  _incrementRecieveCounter = (): void => {
    this._recieveCounter = this._increment(this._recieveCounter);
  };

  /**
   * increments or wraps our token value, and makes sure it isn't in use
   */
  _getNextToken = () => {
    this._sendToken = this._increment(this._sendToken);
  };

  /**
   * Associates a particular token with a message we're sending, so we know
   * what we're getting back when we get an ACK
   * @param name
   * @param token
   */
  _useToken = (name: string, token: string): void => {
    const key = utilities.toHexString(token);

    if (this._tokens[key]) {
      throw 'Token ${name} ${token} ${key} already in use';
    }

    this._tokens[key] = name;
  };

  /**
   * Clears the association with a particular token
   * @param token
   */
  _clearToken = (token: string): void => {
    const key = utilities.toHexString(token);

    if (this._tokens[key]) {
      delete this._tokens[key];
    }
  };

  _getResponseType = (tokenString: string): string => {
    const request = this._tokens[tokenString];
    //logger.log('respType for key ', tokenStr, ' is ', request);

    if (!request) {
      return null;
    }

    return nullthrows(Messages.getResponseType(request));
  };

  /**
   * Ensures we have introspection data from the core, and then
   * requests a variable value to be sent, when received it transforms
   * the response into the appropriate type
   * @param name
   * @param type
   * @param callback - expects (value, buf, err)
   */
  _getVariable = (name: string, type: string, callback: Function): void => {
      const performRequest = (): void => {
        if (!this._hasParticleVariable(name)) {
          callback(null, null, 'Variable not found');
          return;
        }

        const messageToken = this.sendMessage(
          'VariableRequest', { name: name },
        );
        const variableTransformer = this._transformVariableGenerator(
          name,
          callback,
        );
        this.listenFor(
          'VariableValue',
          null,
          messageToken,
          variableTransformer,
          true,
        );
      };

      if (this._hasFunctionState()) {
        //slight short-circuit, saves ~5 seconds every 100,000 requests...
        performRequest();
      } else {
        when(this._ensureWeHaveIntrospectionData())
          .then(
              performRequest,
              error => callback(
                null,
                null,
                'Problem requesting variable: ' + error
              ),
          );
      }
  };

  _setVariable = (name: string, data, callback: Function):void => {

      /*TODO: data type! */
      var payload = Messages.toBinary(data);
      var token = this.sendMessage('VariableRequest', { name: name }, payload);

      //are we expecting a response?
      //watches the messages coming back in, listens for a message of this type with
      this.listenFor('VariableValue', null, token, callback, true);
  };

  _callFunction = (name: string, args, callback: Function): void => {
    when(this._transformArguments(name, args)).then(
      (buffer: Buffer): void => {
          if (settings.showVerboseDeviceLogs) {
            logger.log(
              'sending function call to the core',
              { coreID: this.coreID, name: name },
            );
          }

          const writeUrl = (message: Message): Message => {
            message.setUri('f/' + name);
            if (buffer) {
              message.setUriQuery(buffer.toString());
            }
            return message;
          };

          const token = this.sendMessage(
            'FunctionCall',
            { name: name, args: buffer, _writeCoapUri: writeUrl },
            null,
          );

          //gives us a function that will transform the response, and call the callback with it.
          const resultTransformer =
            this._transformFunctionResultGenerator(name, callback);

          //watches the messages coming back in, listens for a message of this type with
          this.listenFor('FunctionReturn', null, token, resultTransformer, true);
      },
      (error): void => {
        callback({
          Error: 'Something went wrong calling this function: ' + err,
        });
      },
    );
  };

  /**
   * Asks the core to start or stop its 'raise your hand' signal
   * @param showSignal - whether it should show the signal or not
   * @param callback - what to call when we're done or timed out...
   */
  _raiseYourHand = (showSignal: boolean, callback: Function): void => {
    const timer = setTimeout((): void => { callback(false); }, 30 * 1000);

    //TODO: this.stopListeningFor('_raiseYourHandReturn', listenHandler);
    //TODO:  var listenHandler = this.listenFor('_raiseYourHandReturn',  ... );

    //logger.log('_raiseYourHand: asking core to signal? ' + showSignal);
    const token = this.sendMessage(
      '_raiseYourHand',
      { _writeCoapUri: Messages.raiseYourHandUrlGenerator(showSignal) },
      null,
    );
    this.listenFor('_raiseYourHandReturn', null, token, (): void => {
      clearTimeout(timer);
      callback(true);
    }, true);
  };


  flashCore = (binary: ?Buffer, sender): void => {
      if (!binary || (binary.length === 0)) {
        logger.log(
          'flash failed! - file is empty! ',
          { coreID: this.getHexCoreID() },
        );
        this.sendApiResponse(
          sender,
          {
            cmd: 'Event',
            name: 'Update',
            message: 'Update failed - File was too small!',
          },
        );
        return
      }

      if (binary && binary.length > MAX_BINARY_SIZE) {
        logger.log(
          'flash failed! - file is too BIG ' + binary.length,
          { coreID: this.getHexCoreID() },
        );
        this.sendApiResponse(
          sender,
          {
            cmd: 'Event',
            name: 'Update',
            message: 'Update failed - File was too big!',
          },
        );
        return;
      }

      const flasher = new Flasher();
      flasher.startFlashBuffer(
        binary,
        this,
        (): void => {
          logger.log('flash core finished! - sending api event', { coreID: this.getHexCoreID() });
          global.server.publishSpecialEvents('spark/flash/status','success',this.getHexCoreID());
          this.sendApiResponse(sender, { cmd: 'Event', name: 'Update', message: 'Update done' });
        },
        (message: Message): void => {
          logger.log(
            'flash core failed! - sending api event',
            { coreID: this.getHexCoreID(), error: message },
          );
          global.server.publishSpecialEvents(
            'spark/flash/status',
            'failed',
            this.getHexCoreID(),
          );
          this.sendApiResponse(
            sender,
            { cmd: 'Event', name: 'Update', message: 'Update failed' },
          );
        },
        (): void => {
          logger.log(
            'flash core started! - sending api event',
            { coreID: this.getHexCoreID() },
          );
          global.server.publishSpecialEvents(
            'spark/flash/status',
            'started',
            this.getHexCoreID(),
          );
          this.sendApiResponse(
            sender,
            { cmd: 'Event', name: 'Update', message: 'Update started' },
          );
        });
  };


  _isSocketAvailable = (
    requester: Object,
    messageName: string,
  ): boolean => {
    if (!this._owningFlasher || this._owningFlasher === requester) {
      return true;
    }

    logger.error(
      'This client has an exclusive lock',
      {
        coreID: this.getHexCoreID(),
        cache_key: this._connectionKey,
        msgName: messageName,
      },
    );

    return false;
  };

  takeOwnership = (flasher: Flasher): boolean => {
      if (this._owningFlasher) {
        logger.error('already owned', { coreID: this.getHexCoreID() });
        return false;
      }
      //only permit the owning object to send messages.
      this._owningFlasher = flasher;
      return true;
  };
  releaseOwnership = (flasher: Flasher): void => {
    logger.log('releasing flash ownership ', { coreID: this.getHexCoreID() });
    if (this._owningFlasher === flasher) {
      this._owningFlasher = null;
    } else if (this._owningFlasher) {
      logger.error(
        'cannot releaseOwnership, ',
        flasher,
        ' isn\'t the current owner ',
        { coreID: this.getHexCoreID() },
      );
    }
  };


  /**
   * makes sure we have our introspection data, then transforms our object into
   * the right coap query string
   * @param name
   * @param args
   * @returns {*}
   */
  _transformArguments = (name: string, args): void => {
    var ready = when.defer();

    when(this._ensureWeHaveIntrospectionData()).then(
      (): void => {
        const buffer = this._transformArguments(name, args);
        if (buffer) {
          ready.resolve(buffer);
        } else {
          //NOTE! The API looks for 'Unknown Function' in the error response.
          ready.reject('Unknown Function: ' + name);
        }
      },
      (message: string): void => {
        ready.reject(message);
      },
    );

    return ready.promise;
  };


  _transformFunctionResultGenerator = (
    name: string,
    callback: Function,
  ): (message: string) => void => {
    return (message: string): void => {
      this._transformFunctionResult(name, message, callback);
    };
  };

  /**
   *
   * @param name
   * @param callback -- callback expects (value, buf, err)
   * @returns {Function}
   */
  _transformVariableGenerator = (
    name: string,
    callback: Function,
  ): (message: string) => void => {
    return (message: Message): void => {
      this._transformVariableResult(name, message, callback);
    };
  };


  /**
   *
   * @param name
   * @param msg
   * @param callback-- callback expects (value, buf, err)
   * @returns {null}
   */
  _transformVariableResult = (
    name: string,
    message: Message,
    callback: Function,
  ): void => {
    //grab the variable type, if the core doesn't say, assume it's a 'string'
    const variableFunctionState = this._deviceFunctionState
      ? this._deviceFunctionState.v
      : null;
    const variableType = variableFunctionState && variableFunctionState[name]
      ? variableFunctionState[name]
      : 'string';

    let result = null;
    let data = null;
    try {
      if (message && message.getPayload) {
          //leaving raw payload in response message for now, so we don't shock our users.
          data = msg.getPayload();
          result = Messages.fromBinary(data, variableType);
      }
    } catch (exception) {
      logger.error(
        '_transformVariableResult - error transforming response ' +
          exception
      );
    }

    process.nextTick(function () {
      try {
        callback(result, data);
      } catch (exception) {
        logger.error(
          '_transformVariableResult - error in callback ' + exception
        );
      }
    });
  };


  /**
   * Transforms the result from a core function to the correct type.
   * @param name
   * @param msg
   * @param callback
   * @returns {null}
   */
  _transformFunctionResult = (
    name: string,
    message: Message,
    callback: Function,
  ): void => {
      const variableType = 'int32';

      let result = null;
      try {
        if (message && message.getPayload) {
          result = Messages.fromBinary(message.getPayload(), variableType);
        }
      } catch (exception) {
        logger.error(
          '_transformFunctionResult - error transforming response ' +
            exception,
        );
      }

      process.nextTick((): void => {
        try {
          callback(result);
        } catch (exception) {
          logger.error(
            '_transformFunctionResult - error in callback ' + exception,
          );
        }
      });
  };

  /**
   * transforms our object into a nice coap query string
   * @param name
   * @param args
   * @private
   */
  _transformArguments = (name: string, args): ?Buffer => {
      //logger.log('transform args', { coreID: this.getHexCoreID() });
      if (!args) {
        return null;
      }

      if (!this._hasFunctionState()) {
        logger.error(
          '_transformArguments called without any function state!',
          { coreID: this.getHexCoreID() },
        );
        return null;
      }

      //TODO: lowercase function keys on new state format
      name = name.toLowerCase();
      let functionState = this._deviceFunctionState[name];
      if (!functionState || !functionState.args) {
        //maybe it's the old protocol?
        const oldProtocolFunctionState = this._deviceFunctionState.f;
        if (
          oldProtocolFunctionState &&
          utilities.arrayContainsLower(oldProtocolFunctionState, name)
        ) {
          //logger.log('_transformArguments - using old format', { coreID: this.getHexCoreID() });
          //current / simplified function format (one string arg, int return type)
          functionState = {
            returns: 'int',
            args: [
              [null, 'string' ],
            ],
          };
        }
      }

      if (!functionState || !functionState.args) {
          //logger.error('_transformArguments: core doesn't know fn: ', { coreID: this.getHexCoreID(), name: name, state: this._deviceFunctionState });
          return null;
      }

      //  'HelloWorld': { returns: 'string', args: [ {'name': 'string'}, {'adjective': 'string'}  ]} };
      return Messages.buildArguments(args, functionState.args);
  };

  /**
   * Checks our cache to see if we have the function state, otherwise requests it from the core,
   * listens for it, and resolves our deferred on success
   * @returns {*}
   */
  _ensureWeHaveIntrospectionData = ():void => {
    if (this._hasFunctionState()) {
      return when.resolve();
    }

    //if we don't have a message pending, send one.
    if (!this._describeDfd) {
      this.sendMessage('Describe');
      this._describeDfd = when.defer();
    }

    //let everybody else queue up on this promise
    return this._describeDfd.promise;
  };


  /**
   * On any describe return back from the core
   * @param msg
   */
  _onDescribeReturn = (message: Message): void =>  {
    //got a description, is it any good?
    const loaded = this._loadFunctionState(message.getPayload());

    if (this._describeDfd) {
      if (loaded) {
        this._describeDfd.resolve();
      } else {
        this._describeDfd.reject('something went wrong parsing function state');
      }
    }
    //else { //hmm, unsolicited response, that's okay. }
  };

  //-------------
  // Core Events / Spark.publish / Spark.subscribe
  //-------------

  _onCorePrivateEvent = (message: Message): void => {
    this._onCoreSentEvent(message, false);
  };
  _onCorePublicEvent = (message: Message): void => {
    this._onCoreSentEvent(message, true);
  };

  _onCoreSentEvent = (message: Message, isPublic: boolean): void => {
    if (!message) {
      logger.error('CORE EVENT - msg obj was empty?!');
      return;
    }

    //TODO: if the core is publishing messages too fast:
    //this.sendReply('EventSlowdown', msg.getId());

    //name: '/E/TestEvent', trim the '/e/' or '/E/' off the start of the uri
    const eventData = {
      name: message.getUriPath().substr(3),
      is_public: isPublic,
      ttl: message.getMaxAge(),
      data: message.getPayload().toString(),
      published_by: this.getHexCoreID(),
      published_at: moment().toISOString()
    };

    //snap obj.ttl to the right value.
    eventData.ttl = (eventData.ttl > 0) ? eventData.ttl : 60;

    //snap data to not incorrectly default to an empty string.
    if (message.getPayloadLength() === 0) {
      eventData.data = null;
    }

//logger.log(JSON.stringify(obj));

    //if the event name starts with spark (upper or lower), then eat it.
    const lowername = eventData.name.toLowerCase();
    const coreId = this.getHexCoreID();

    if (lowername.indexOf('spark/device/claim/code') === 0) {
    	const claimCode = message.getPayload().toString();

    	const coreAttributes = global.server.getCoreAttributes(coreId);

    	if (coreAttributes.claimCode !== claimCode) {
	        global.server.setCoreAttribute(coreId, 'claimCode', claimCode);
      	//claim device
      	if (global.api) {
      		global.api.linkDevice(coreId, claimCode, this._particleProductId);
      	}
      }
    }

    if (lowername.indexOf('spark/device/system/version') === 0) {
    	global.server.setCoreAttribute(
        coreId,
        'spark_system_version',
        message.getPayload().toString(),
      );
    }

    if (lowername.indexOf('spark/device/safemode')===0) {
    	const token = this.sendMessage('Describe');
    	this.listenFor(
        'DescribeReturn',
        null,
        token,
        (systemMessage: Message): void => {
      		//console.log('device '+coreid+' is in safe mode: '+sysmsg.getPayload().toString());
    			global.api && global.api.safeMode(
            coreId,
            systemMessage.getPayload().toString(),
          );
      	},
        true,
      );
    }

    if (lowername.indexOf('spark') === 0) {
      //allow some kinds of message through.
      var eat_message = true;

      //if we do let these through, make them private.
      isPublic = false;

      //TODO:
      //if the message is 'cc3000-radio-version', save to the core_state collection for this core?
      if (lowername === 'spark/cc3000-patch-version') {
        // set_cc3000_version(this.coreID, obj.data);
        // eat_message = false;
      }

      if (eat_message) {
        //short-circuit
        this.sendReply('EventAck', message.getId());
        return;
      }
    }


    try {
      if (!global.publisher) {
        return;
      }

      const result = global.publisher.publish(
        isPublic,
        eventData.name,
        eventData.userid,
        eventData.data,
        eventData.ttl,
        eventData.published_at,
        this.getHexCoreID(),
      );

      if (!result) {
        //this core is over its limit, and that message was not sent.
        //this.sendReply('EventSlowdown', msg.getId());
      }

      if(message.isConfirmable()) {
        //console.log('Event confirmable');
        this.sendReply( 'EventAck', message.getId() );
      } else {
        //console.log('Event non confirmable');
      }
    } catch (exception) {
      logger.error(
        '_onCoreSentEvent: failed writing to socket - ' + exception,
      );
    }
  };

  /**
   * The core asked us for the time!
   * @param msg
   */
  _onCoreGetTime = (message: Message): void => {
    //moment#unix outputs a Unix timestamp (the number of seconds since the Unix Epoch).
    const stamp = moment().utc().unix();
    const binaryValue = Messages.toBinary(stamp, 'uint32');

    this.sendReply(
      'GetTimeReturn',
      message.getId(),
      binaryValue,
      message.getToken(),
    );
  };

  onCorePublicSubscribe = (message: Message): void => {
    this.onCoreSubscribe(message, true);
  };
  onCoreSubscribe = (message: Message, isPublic: boolean): void => {
      const name = message.getUriPath().substr(3);

      //var body = resp.getPayload().toString();
      //logger.log('Got subscribe request from core, path was \'' + name + '\'');
      //uri -> /e/?u    --> firehose for all my devices
      //uri -> /e/ (deviceid in body)   --> allowed
      //uri -> /e/    --> not allowed (no global firehose for cores, kthxplox)
      //uri -> /e/event_name?u    --> all my devices
      //uri -> /e/event_name?u (deviceid)    --> deviceid?

      if (!name) {
        //no firehose for cores
        this.sendReply('SubscribeFail', message.getId());
        return;
      }

      const query = message.getUriQuery();
      const payload = message.getPayload();
      const myDevices = query && query.indexOf('u') >= 0;
      const userid = myDevices ? (this.userID || '').toLowerCase() : null;
      const deviceID = payload ? payload.toString() : null;

      //TODO: filter by a particular deviceID

      this.sendReply('SubscribeAck', message.getId());

      //modify our filter on the appropriate socket (create the socket if we haven't yet) to let messages through
      //this.eventsSocket.subscribe(isPublic, name, userid);
      global.publisher.subscribe(name, userid,deviceID,this,this.onCoreEvent);
  };

  _onCorePublicHeard = (name, data, ttl, published_at, coreid): void => {
    this.sendCoreEvent(true, name, data, ttl, published_at, coreid);
  };
  _onCorePrivateHeard = (name, data, ttl, published_at, coreid): void => {
    this.sendCoreEvent(false, name, data, ttl, published_at, coreid);
  };
  // isPublic, name, userid, data, ttl, published_at, coreid);
  onCoreEvent = (
    isPublic: boolean,
    name: string,
    userid: string,
    data: Object,
    ttl: number,
    published_at: Date,
    coreid: string,
  ): void => {
    this.sendCoreEvent(isPublic, name, data, ttl, published_at, coreid);
  };

  /**
   * sends a received event down to a core
   * @param isPublic
   * @param name
   * @param data
   * @param ttl
   * @param published_at
   */
  sendCoreEvent = (
    isPublic: boolean,
    name: string,
    data: Object,
    ttl: number,
    published_at: Date,
    coreid: string,
  ): void => {
    const rawFunction = (message: Message): void => {
      try {
        message.setMaxAge(parseInt((ttl && (ttl >= 0)) ? ttl : 60));
        if (published_at) {
          message.setTimestamp(moment(published_at).toDate());
        }
      } catch (exception) {
        logger.error('onCoreHeard - ' + exception);
      }

      return message;
    };

    const messageName = isPublic ? 'PublicEvent' : 'PrivateEvent';
    const userID = (this.userID || '').toLowerCase() + '/';
    name = name ? name.toString() : name;
    if (name && name.indexOf && (name.indexOf(userID)===0)) {
      name = name.substring(userID.length);
    }

    data = data ? data.toString() : data;
    this.sendMessage(
      messageName,
      { event_name: name, _raw: rawFunction },
      data,
    );
  };

  _hasFunctionState = ():void => {
    return !!this._deviceFunctionState;
  };

  _hasParticleVariable = (name: string):void => {
    return (
      this._deviceFunctionState &&
      this._deviceFunctionState.v &&
      this._deviceFunctionState.v[name]
    );
  };

  HasSparkFunction = (name: string):void => {
    //has state, and... the function is an object, or it's in the function array
    return (
      this._deviceFunctionState &&
      (
        this._deviceFunctionState[name] ||
        (
          this._deviceFunctionState.f &&
          utilities.arrayContainsLower(this._deviceFunctionState.f, name)
        )
      )
    );
  };

  /**
   * interprets the introspection message from the core containing
   * argument names / types, and function return types, so we can make it easy to call functions
   * on the core.
   * @param data
   */
  _loadFunctionState = (data: Buffer):boolean => {
    const functionState = JSON.parse(data.toString());

    if (functionState && functionState.v) {
      //'v':{'temperature':2}
      functionState.v = Messages.translateIntTypes(functionState.v);
    }

    this._deviceFunctionState = functionState;

    return true;
  };

  getHexCoreID = ():string => {
    return this.coreID ? this.coreID.toString('hex') : 'unknown';
  };

  getRemoteIPAddress = ():string => {
    return this._socket && this._socket.remoteAddress
      ? this._socket.remoteAddress.toString()
      : 'unknown';
  };

  disconnect = (message: string):void => {
    message = message || '';
    this._disconnectCounter++;

    if (this._disconnectCounter > 1) {
      //don't multi-disconnect
      return;
    }

    try {
      const logInfo = {
        coreID: this.getHexCoreID(),
        cache_key: this._connectionKey,
        duration: this._connectionStartTime
         ? ((new Date()) - this._connectionStartTime) / 1000.0
         : undefined,
      };

      logger.log(
        this._disconnectCounter + ': Core disconnected: ' + message,
        logInfo,
      );
    } catch (exception) {
      logger.error('Disconnect log error ' + exception);
    }

    try {
      if (this._socket) {
        this._socket.end();
        this._socket.destroy();
        this._socket = null;
      }
    } catch (exception) {
      logger.error('Disconnect TCPSocket error: ' + exception);
    }

    if (this._decipherStream) {
      try {
        this._decipherStream.end();
        this._decipherStream = null;
      } catch (exception) {
        logger.error('Error cleaning up _decipherStream ', exception);
      }
    }

    if (this._cipherStream) {
      try {
        this._cipherStream.end();
        this._cipherStream = null;
      } catch (exception) {
        logger.error('Error cleaning up _cipherStream ', exception);
      }
    }

    this.emit('disconnect', message);

    //obv, don't do this before emitting disconnect.
    try {
      this.removeAllListeners();
    } catch (ex) {
      logger.error('Problem removing listeners ', ex);
    }
  }
};
module.exports = SparkCore;