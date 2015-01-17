!function(e){if("object"==typeof exports&&"undefined"!=typeof module)module.exports=e();else if("function"==typeof define&&define.amd)define([],e);else{var f;"undefined"!=typeof window?f=window:"undefined"!=typeof global?f=global:"undefined"!=typeof self&&(f=self),f.Handshake=e()}}(function(){var define,module,exports;return (function e(t,n,r){function s(o,u){if(!n[o]){if(!t[o]){var a=typeof require=="function"&&require;if(!u&&a)return a(o,!0);if(i)return i(o,!0);var f=new Error("Cannot find module '"+o+"'");throw f.code="MODULE_NOT_FOUND",f}var l=n[o]={exports:{}};t[o][0].call(l.exports,function(e){var n=t[o][1][e];return s(n?n:e)},l,l.exports,e,t,n,r)}return n[o].exports}var i=typeof require=="function"&&require;for(var o=0;o<r.length;o++)s(r[o]);return s})({1:[function(require,module,exports){
/**
 * Created by Julian on 12/17/2014.
 */
var Utils = require("yutils");
exports.LocalAddress = Utils.guid();
},{"yutils":42}],2:[function(require,module,exports){
/**
 * Created by Julian on 12/16/2014.
 */
exports.MESSAGE = 0;
exports.TELL_ADDRESS = 1;
exports.REQUEST_NEIGHBORS = 2;
exports.OFFER = 3;
exports.ANSWER = 4;
exports.ERROR_CANNOT_FIND_PEER = 5;
exports.SEND_NEIGHBORS = 6;
},{}],3:[function(require,module,exports){
/**
 * Created by Julian on 12/16/2014.
 */
var WebRTC = require("webrtc-adapter");
var RTCPeerConnection = WebRTC.RTCPeerConnection;
var MESSAGE_TYPE = require("./MESSAGE_TYPE.js");
var ADDRESS = require("./Address").LocalAddress;
var PeerCache = require("./PeerCache").PeerCache;
var Handshake = require("./handshake.js");
var Promise = require("bluebird");

var REQUEST_NEIGHBORS_TIMEOUT_MS = 5000;

var ICE_CONFIG = {"iceServers":[
    {"url":"stun:23.21.150.121"},
    {
        'url': 'turn:192.158.29.39:3478?transport=udp',
        'credential': 'JZEOEt2V3Qb0y27GRntt2u2PAYA=',
        'username': '28224511:1379330808'
    }
]};

var CONN = { 'optional': [{'DtlsSrtpKeyAgreement': true}] };

/**
 *
 * @constructor
 */
function Peer() {
    var pc = new RTCPeerConnection(ICE_CONFIG, CONN);
    this.pc = pc;
    this.verbose = false;
    this.address = null;
    this.dc = null;
    this.onOpen = [];
    this.onMessage = [];
    this.onDisconnect = [];
    this.offerCallback = null;
    this.createCallback = null;
    this.iceTimeout = null;
    this.onCannotFindPeer = [];
    this.requestNeighbors = null;
    this.requestNeighborsCallback = null;
    var self = this;

    this.disconnectCounter = 0; // to prevent "false" positive...
    this.thread = setInterval(function () {
        var i = 0, L = self.onDisconnect.length;
        if (self.dc !== null) {
            if( self.dc.readyState === "closed") {
                if (self.disconnectCounter > 5) {
                    for(;i<L;i++) {
                        self.onDisconnect[i].call(self);
                    }
                    clearInterval(self.thread);
                } else {
                    self.disconnectCounter += 1;
                }
            } else {
                self.disconnectCounter = 0;
            }
        }
    }, 100);

    /**
     * returns the result
     */
    function exec() {
        clearTimeout(self.iceTimeout);
        var d = JSON.stringify(pc.localDescription);
        if (self.offerCallback !== null) {
            self.offerCallback.call(self, d);
            self.offerCallback = null;
        } else if (self.createCallback !== null) {
            self.createCallback.call(self, d);
            self.createCallback = null;
        }
        pc.onicecandidate = null;
    }

    pc.onicecandidate = function (e) {
        if (e.candidate === null) {
            exec();
        } else {
            if (self.iceTimeout !== null) {
                clearTimeout(self.iceTimeout);
            }
            self.iceTimeout = setTimeout(function () {
                exec();
            }, 1000);
        }
    };

    /*
    pc.onpeeridentity = function (e) {
        //console.log("peer ident:",e);
    }

    pc.onsignalingstatechange = function(ev) {
        //console.log("onsignalingstatechange event detected!", ev);
    };
    */
}

Peer.prototype.isOpen = function () {
    if (this.verbose) {
        console.log('Peer {' + this.address + '} is open...');
    }
    if (this.dc !== null) {
        return this.dc.readyState === "open";
    }
    return false;
};

Peer.prototype.disconnect = function () {
    this.dc.close();
};

Peer.prototype.ondisconnect = function (callback) {
    this.onDisconnect.push(callback);
};

Peer.prototype.onopen = function (callback) {
    this.onOpen.push(callback);
};

Peer.prototype.onmessage = function (callback) {
    this.onMessage.push(callback);
};

Peer.prototype.oncannotfindpeer = function (callback) {
    this.onCannotFindPeer.push(callback);
};

/**
 * Send any kind of data to the other Peer
 * @param message
 */
Peer.prototype.send = function (message) {
    if (this.dc === null || this.dc.readyState !== "open") {
        throw new Error("Handshake incomplete! Sending is not possible.");
    }
    this.dc.send(JSON.stringify({type: MESSAGE_TYPE.MESSAGE, payload:message }));
    if (this.verbose) {
        console.log('send to Peer {' + this.address + '} message: ', message);
    }
};

/**
 * Sends a message without payload
 * @param messageType
 */
Peer.prototype.sendMessageType = function (messageType, payload) {
    if (this.dc === null || this.dc.readyState !== "open") {
        throw new Error("Handshake incomplete! Sending is not possible.");
    }
    if (typeof payload === "undefined") {
        this.dc.send(JSON.stringify({type: messageType }));
    } else {
        this.dc.send(JSON.stringify({type: messageType, payload: payload }));
    }
    if (this.verbose) {
        console.log('send to Peer {' + this.address + '} message: ', {type:messageType, payload:payload});
    }
};

/**
 * Tries to connect to the address through the peer
 * @param address {String}
 * @returns {Peer} resulting peer
 */
Peer.prototype.attemptToConnect = function (address) {
    var self = this;
    var other = Handshake.createOffer(function (offer) {
        self.sendMessageType(MESSAGE_TYPE.OFFER, {offer:offer, target:address, source:ADDRESS});
    });
    PeerCache.putPending(other, address);
    if (this.verbose) {
        console.log('ask Peer {' + this.address + '} to connect us with: ' + address);
    }
    return other;
};

/**
 *
 * @returns {Promise}
 */
Peer.prototype.getNeighbors = function () {
    if (this.requestNeighbors !== null) {
        console.warn("already requesting neighbors.. cancel old request!");
        this.requestNeighbors.cancel();
    }
    var self = this;
    this.requestNeighbors = new Promise(function (resolve, reject) {
        var timeout = setTimeout(function () {
            self.requestNeighbors = null;
            self.requestNeighborsCallback = null;
            reject();
        },REQUEST_NEIGHBORS_TIMEOUT_MS);
        self.requestNeighborsCallback = function (neighbors) {
            clearTimeout(timeout);
            self.requestNeighbors = null;
            self.requestNeighborsCallback = null;
            resolve(neighbors);
        }
        self.sendMessageType(MESSAGE_TYPE.REQUEST_NEIGHBORS);
    }).cancellable();
    return this.requestNeighbors;
};

exports.Peer = Peer;
},{"./Address":1,"./MESSAGE_TYPE.js":2,"./PeerCache":4,"./handshake.js":5,"bluebird":8,"webrtc-adapter":41}],4:[function(require,module,exports){
/**
 * Caches connections that are opened and not closed yet for the purpose of signaling
 *
 * Created by Julian on 12/17/2014.
 */
var Utils = require("yutils");

var cache = {};

var pending = {};

exports.PeerCache = {

    getAllAddresses: function () {
        return Object.keys(cache);
    },

    /**
     * Put a Peer that is already open
     * @param peer {Peer}
     */
    put: function (peer) {
        if (!peer.isOpen()) throw new Error("Cannot put not-opened peers into cache!");
        if (peer.address in cache) throw new Error("Connection is already open! Cannot put into cache."); //TODO really..?

        cache[peer.address] = peer;

        // Clear when disconnected
        peer.ondisconnect(function () {
            delete cache[peer.address];
        });
    },

    has: function (address) {
        return address in cache;
    },

    get: function (address) {
        return cache[address];
    },

    putPending: function (peer, address) {
        if (peer.isOpen()) throw new Error("Cannot at peer to pending because it is already open!");
        if (address in pending) throw new Error("Connection is already pending! Cannot put into cache."); //TODO really..?

        peer.onopen(function () {
            delete pending[address];
        });

        pending[address] = {peer: peer, ts: Date.now()};
    },

    getPending: function (address) {
        return pending[address].peer;
    },

    deletePending: function (address) {
        delete pending[address];

    }

};

// =======================================
// CLEAN PENDING CACHE
// =======================================
setInterval(function () {
    var key, s, now = Date.now(), current;
    for(key in pending) {
        current = pending[key];
        s = Utils.msToS(Utils.timeDifferenceInMs(current.ts, now));
        if (s > 60) {
            // if a connection is pending for more than 1 minute, close it..
            current.peer.disconnect();
            delete pending[key];
        }
    }
}, 30000); // every 30 seconds

},{"yutils":42}],5:[function(require,module,exports){
/**
 * Created by Julian on 12/11/2014.
 */
var Utils = require("yutils");
var Peer = require("./Peer.js").Peer;
var PeerCache = require("./PeerCache.js").PeerCache;
var MESSAGE_TYPE = require("./MESSAGE_TYPE.js");
var ADDRESS = require("./Address").LocalAddress;

var onRemoteConnectionCallbacks = [];
var onMessageCallbacks = [];

function onMessage(peer) {
    return function (msg) {
        var i = 0, cb = onMessageCallbacks, L = cb.length;
        for(;i<L;i++) {
            cb[i].call(peer, peer, msg);
        }
    }
}

/**
 * @type {Object}
 * {
 *      guid1 : peer,
 *      guid2 : peer
 * }
 */

/* ====================================
 A P I
 ==================================== */

/**
 * initiates a Peer-to-Peer connection
 * @param callback
 * @returns {Peer}
 */
function createOffer(callback) {
    var peer = new Peer(), pc = peer.pc;
    peer.offerCallback = callback;

    var dc = pc.createDataChannel("q", {reliable:true});
    pc.createOffer(function (desc) {
        pc.setLocalDescription(desc, function() { });
    }, function failure(e) { console.error(e); });

    dc.onopen = function () {
        dc.send(JSON.stringify({type: MESSAGE_TYPE.TELL_ADDRESS, payload: ADDRESS}));
    };

    dc.onmessage = handleMessage(peer);

    peer.dc = dc;
    return peer;
}

/**
 *
 * @param peer
 * @returns {Function}
 */
function handleMessage(peer) {
    return function (e) {
        var msg = Utils.isString(e.data) ? JSON.parse(e.data) : e.data;
        var i, L, newPeer, destinationPeer, n;
        switch (msg.type) {
            case MESSAGE_TYPE.OFFER:
                // =======================================
                // O F F E R
                // =======================================
                if ("target" in msg.payload) {
                    // we are the mediator
                    if (PeerCache.has(msg.payload.target)) {
                        destinationPeer = PeerCache.get(msg.payload.target);
                        destinationPeer.sendMessageType(MESSAGE_TYPE.OFFER, {offer:msg.payload.offer, source:msg.payload.source});
                    } else {
                        // we cannot establish a connection..
                        peer.sendMessageType(MESSAGE_TYPE.ERROR_CANNOT_FIND_PEER, msg.payload.target);
                    }
                } else {
                    // WE are the TARGET!
                    newPeer = createAnswer(msg.payload.offer, function (answer) {
                        peer.sendMessageType(
                            MESSAGE_TYPE.ANSWER, {
                                answer: answer,
                                source: msg.payload.source,
                                target: ADDRESS
                            }
                        );
                    });
                    i = 0, L = onRemoteConnectionCallbacks.length;
                    for(;i<L;i++) {
                        onRemoteConnectionCallbacks[i].call(newPeer,newPeer);
                    }
                }
                break;
            case MESSAGE_TYPE.ANSWER:
                // =======================================
                // A N S W E R
                // =======================================
                if ("source" in msg.payload) {
                    // we are the mediator..
                    if (PeerCache.has(msg.payload.source)) {
                        destinationPeer = PeerCache.get(msg.payload.source);
                        destinationPeer.sendMessageType(MESSAGE_TYPE.ANSWER, {
                            answer: msg.payload.answer,
                            target: msg.payload.target
                        });
                    } else {
                        peer.sendMessageType(MESSAGE_TYPE.ERROR_CANNOT_FIND_PEER, msg.payload.target);
                    }
                } else {
                    // we are the SENDER and we are supposed to apply the answer..
                    destinationPeer = PeerCache.getPending(msg.payload.target);
                    handleAnswer(destinationPeer, msg.payload.answer);
                }
                break;
            case MESSAGE_TYPE.TELL_ADDRESS:
                // =======================================
                // T E L L  A D D R E S S
                // =======================================
                peer.address = msg.payload;
                i = 0, L = peer.onOpen.length;
                PeerCache.put(peer);
                peer.onmessage(onMessage(peer));
                for(;i<L;i++) {
                    peer.onOpen[i].call(peer);
                }
                peer.onOpen = null;
                break;
            case MESSAGE_TYPE.MESSAGE:
                // =======================================
                // M E S S A G E
                // =======================================
                i = 0, L = peer.onMessage.length;
                for(;i<L;i++) {
                    peer.onMessage[i].call(peer, msg.payload);
                }
                break;
            case MESSAGE_TYPE.ERROR_CANNOT_FIND_PEER:
                // =======================================
                // E R R O R  C A N N O T  F I N D  P E E R
                // =======================================
                i=0, L = peer.onCannotFindPeer.length;
                PeerCache.deletePending(msg.payload);
                for (;i<L;i++) {
                    peer.onCannotFindPeer[i].call(peer, msg.payload);
                }
                break;
            case MESSAGE_TYPE.REQUEST_NEIGHBORS:
                // =======================================
                // R E Q U E S T  N E I G H B O R S
                // =======================================
                peer.sendMessageType(MESSAGE_TYPE.SEND_NEIGHBORS, PeerCache.getAllAddresses());
                break;
            case MESSAGE_TYPE.SEND_NEIGHBORS:
                // =======================================
                // S E N D  N E I G H B O R S
                // =======================================
                n = Utils.isString(msg.payload)? JSON.parse(msg.payload) : msg.payload;
                peer.requestNeighborsCallback.call(peer, n);
                break;
        }
    };
}

/**
 * Accepts the initial Peer-to-Peer invitation
 * @param offer
 * @param callback
 * @returns {Peer}
 */
function createAnswer(offer, callback) {
    var peer = new Peer(), pc = peer.pc;
    var offerDesc = new RTCSessionDescription(JSON.parse(offer));
    peer.createCallback = callback;
    pc.setRemoteDescription(offerDesc);
    pc.createAnswer(function (answerDesc) {
        pc.setLocalDescription(answerDesc);
    }, function () { console.warn("No create answer"); });

    pc.ondatachannel = function (e) {
        var dc = e.channel || e; // Chrome sends event, FF sends raw channel
        peer.dc = dc;

        dc.onopen = function () {
            dc.send(JSON.stringify({type: MESSAGE_TYPE.TELL_ADDRESS, payload: ADDRESS}));
            // delay open until the response is in
        };

        dc.onmessage = handleMessage(peer);
    };

    return peer;
}

/**
 * Applies the result
 * @param peer
 * @param answer
 */
function handleAnswer(peer, answer) {
    var answerDesc = new RTCSessionDescription(JSON.parse(answer));
    peer.pc.setRemoteDescription(answerDesc);
}

/**
 * We somehow need to notify Bob, that Alice attempts to talk to him!
 * @param callback {function} ({Peer})
 */
function onRemoteConnection(callback) {
    onRemoteConnectionCallbacks.push(callback);
};

/**
 *
 * @param callback {function} (Peer, Object)
 */
function onmessage(callback) {
    onMessageCallbacks.push(callback);
}

/**
 *
 * @param address
 */
function getPeer(address) {
    var current = PeerCache.get(address);
    if (current) {
        return current;
    } else {
        return null;
    }
}

/* ====================================
 EXPORT
 ==================================== */
exports.onmessage = onmessage;
exports.createOffer = createOffer;
exports.handleAnswer = handleAnswer;
exports.createAnswer = createAnswer;
exports.onRemoteConnection = onRemoteConnection;
exports.getPeer = getPeer;
exports.address = function () {
    return ADDRESS;
};
},{"./Address":1,"./MESSAGE_TYPE.js":2,"./Peer.js":3,"./PeerCache.js":4,"yutils":42}],6:[function(require,module,exports){
/**
 * The MIT License (MIT)
 * 
 * Copyright (c) 2014 Petka Antonov
 * 
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:</p>
 * 
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * 
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.  IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 * 
 */
"use strict";
module.exports = function(Promise) {
var SomePromiseArray = Promise._SomePromiseArray;
function Promise$_Any(promises) {
    var ret = new SomePromiseArray(promises);
    var promise = ret.promise();
    if (promise.isRejected()) {
        return promise;
    }
    ret.setHowMany(1);
    ret.setUnwrap();
    ret.init();
    return promise;
}

Promise.any = function Promise$Any(promises) {
    return Promise$_Any(promises);
};

Promise.prototype.any = function Promise$any() {
    return Promise$_Any(this);
};

};

},{}],7:[function(require,module,exports){
(function (process){
/**
 * The MIT License (MIT)
 * 
 * Copyright (c) 2014 Petka Antonov
 * 
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:</p>
 * 
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * 
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.  IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 * 
 */
"use strict";
var schedule = require("./schedule.js");
var Queue = require("./queue.js");
var errorObj = require("./util.js").errorObj;
var tryCatch1 = require("./util.js").tryCatch1;
var _process = typeof process !== "undefined" ? process : void 0;

function Async() {
    this._isTickUsed = false;
    this._schedule = schedule;
    this._length = 0;
    this._lateBuffer = new Queue(16);
    this._functionBuffer = new Queue(65536);
    var self = this;
    this.consumeFunctionBuffer = function Async$consumeFunctionBuffer() {
        self._consumeFunctionBuffer();
    };
}

Async.prototype.haveItemsQueued = function Async$haveItemsQueued() {
    return this._length > 0;
};

Async.prototype.invokeLater = function Async$invokeLater(fn, receiver, arg) {
    if (_process !== void 0 &&
        _process.domain != null &&
        !fn.domain) {
        fn = _process.domain.bind(fn);
    }
    this._lateBuffer.push(fn, receiver, arg);
    this._queueTick();
};

Async.prototype.invoke = function Async$invoke(fn, receiver, arg) {
    if (_process !== void 0 &&
        _process.domain != null &&
        !fn.domain) {
        fn = _process.domain.bind(fn);
    }
    var functionBuffer = this._functionBuffer;
    functionBuffer.push(fn, receiver, arg);
    this._length = functionBuffer.length();
    this._queueTick();
};

Async.prototype._consumeFunctionBuffer =
function Async$_consumeFunctionBuffer() {
    var functionBuffer = this._functionBuffer;
    while (functionBuffer.length() > 0) {
        var fn = functionBuffer.shift();
        var receiver = functionBuffer.shift();
        var arg = functionBuffer.shift();
        fn.call(receiver, arg);
    }
    this._reset();
    this._consumeLateBuffer();
};

Async.prototype._consumeLateBuffer = function Async$_consumeLateBuffer() {
    var buffer = this._lateBuffer;
    while(buffer.length() > 0) {
        var fn = buffer.shift();
        var receiver = buffer.shift();
        var arg = buffer.shift();
        var res = tryCatch1(fn, receiver, arg);
        if (res === errorObj) {
            this._queueTick();
            if (fn.domain != null) {
                fn.domain.emit("error", res.e);
            } else {
                throw res.e;
            }
        }
    }
};

Async.prototype._queueTick = function Async$_queue() {
    if (!this._isTickUsed) {
        this._schedule(this.consumeFunctionBuffer);
        this._isTickUsed = true;
    }
};

Async.prototype._reset = function Async$_reset() {
    this._isTickUsed = false;
    this._length = 0;
};

module.exports = new Async();

}).call(this,require('_process'))

},{"./queue.js":30,"./schedule.js":33,"./util.js":40,"_process":43}],8:[function(require,module,exports){
/**
 * The MIT License (MIT)
 * 
 * Copyright (c) 2014 Petka Antonov
 * 
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:</p>
 * 
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * 
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.  IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 * 
 */
"use strict";
var Promise = require("./promise.js")();
module.exports = Promise;
},{"./promise.js":25}],9:[function(require,module,exports){
/**
 * The MIT License (MIT)
 * 
 * Copyright (c) 2014 Petka Antonov
 * 
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:</p>
 * 
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * 
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.  IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 * 
 */
"use strict";
var cr = Object.create;
if (cr) {
    var callerCache = cr(null);
    var getterCache = cr(null);
    callerCache[" size"] = getterCache[" size"] = 0;
}

module.exports = function(Promise) {
var util = require("./util.js");
var canEvaluate = util.canEvaluate;
var isIdentifier = util.isIdentifier;

function makeMethodCaller (methodName) {
    return new Function("obj", "                                             \n\
        'use strict'                                                         \n\
        var len = this.length;                                               \n\
        switch(len) {                                                        \n\
            case 1: return obj.methodName(this[0]);                          \n\
            case 2: return obj.methodName(this[0], this[1]);                 \n\
            case 3: return obj.methodName(this[0], this[1], this[2]);        \n\
            case 0: return obj.methodName();                                 \n\
            default: return obj.methodName.apply(obj, this);                 \n\
        }                                                                    \n\
        ".replace(/methodName/g, methodName));
}

function makeGetter (propertyName) {
    return new Function("obj", "                                             \n\
        'use strict';                                                        \n\
        return obj.propertyName;                                             \n\
        ".replace("propertyName", propertyName));
}

function getCompiled(name, compiler, cache) {
    var ret = cache[name];
    if (typeof ret !== "function") {
        if (!isIdentifier(name)) {
            return null;
        }
        ret = compiler(name);
        cache[name] = ret;
        cache[" size"]++;
        if (cache[" size"] > 512) {
            var keys = Object.keys(cache);
            for (var i = 0; i < 256; ++i) delete cache[keys[i]];
            cache[" size"] = keys.length - 256;
        }
    }
    return ret;
}

function getMethodCaller(name) {
    return getCompiled(name, makeMethodCaller, callerCache);
}

function getGetter(name) {
    return getCompiled(name, makeGetter, getterCache);
}

function caller(obj) {
    return obj[this.pop()].apply(obj, this);
}
Promise.prototype.call = function Promise$call(methodName) {
    var $_len = arguments.length;var args = new Array($_len - 1); for(var $_i = 1; $_i < $_len; ++$_i) {args[$_i - 1] = arguments[$_i];}
    if (canEvaluate) {
        var maybeCaller = getMethodCaller(methodName);
        if (maybeCaller !== null) {
            return this._then(maybeCaller, void 0, void 0, args, void 0);
        }
    }
    args.push(methodName);
    return this._then(caller, void 0, void 0, args, void 0);
};

function namedGetter(obj) {
    return obj[this];
}
function indexedGetter(obj) {
    return obj[this];
}
Promise.prototype.get = function Promise$get(propertyName) {
    var isIndex = (typeof propertyName === "number");
    var getter;
    if (!isIndex) {
        if (canEvaluate) {
            var maybeGetter = getGetter(propertyName);
            getter = maybeGetter !== null ? maybeGetter : namedGetter;
        } else {
            getter = namedGetter;
        }
    } else {
        getter = indexedGetter;
    }
    return this._then(getter, void 0, void 0, propertyName, void 0);
};
};

},{"./util.js":40}],10:[function(require,module,exports){
/**
 * The MIT License (MIT)
 * 
 * Copyright (c) 2014 Petka Antonov
 * 
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:</p>
 * 
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * 
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.  IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 * 
 */
"use strict";
module.exports = function(Promise, INTERNAL) {
var errors = require("./errors.js");
var canAttach = errors.canAttach;
var async = require("./async.js");
var CancellationError = errors.CancellationError;

Promise.prototype._cancel = function Promise$_cancel(reason) {
    if (!this.isCancellable()) return this;
    var parent;
    var promiseToReject = this;
    while ((parent = promiseToReject._cancellationParent) !== void 0 &&
        parent.isCancellable()) {
        promiseToReject = parent;
    }
    this._unsetCancellable();
    promiseToReject._attachExtraTrace(reason);
    promiseToReject._rejectUnchecked(reason);
};

Promise.prototype.cancel = function Promise$cancel(reason) {
    if (!this.isCancellable()) return this;
    reason = reason !== void 0
        ? (canAttach(reason) ? reason : new Error(reason + ""))
        : new CancellationError();
    async.invokeLater(this._cancel, this, reason);
    return this;
};

Promise.prototype.cancellable = function Promise$cancellable() {
    if (this._cancellable()) return this;
    this._setCancellable();
    this._cancellationParent = void 0;
    return this;
};

Promise.prototype.uncancellable = function Promise$uncancellable() {
    var ret = new Promise(INTERNAL);
    ret._propagateFrom(this, 2 | 4);
    ret._follow(this);
    ret._unsetCancellable();
    return ret;
};

Promise.prototype.fork =
function Promise$fork(didFulfill, didReject, didProgress) {
    var ret = this._then(didFulfill, didReject, didProgress,
                         void 0, void 0);

    ret._setCancellable();
    ret._cancellationParent = void 0;
    return ret;
};
};

},{"./async.js":7,"./errors.js":15}],11:[function(require,module,exports){
/**
 * The MIT License (MIT)
 * 
 * Copyright (c) 2014 Petka Antonov
 * 
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:</p>
 * 
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * 
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.  IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 * 
 */
"use strict";
module.exports = function() {
var inherits = require("./util.js").inherits;
var defineProperty = require("./es5.js").defineProperty;

var rignore = new RegExp(
    "\\b(?:[a-zA-Z0-9.]+\\$_\\w+|" +
    "tryCatch(?:1|2|3|4|Apply)|new \\w*PromiseArray|" +
    "\\w*PromiseArray\\.\\w*PromiseArray|" +
    "setTimeout|CatchFilter\\$_\\w+|makeNodePromisified|processImmediate|" +
    "process._tickCallback|nextTick|Async\\$\\w+)\\b"
);

var rtraceline = null;
var formatStack = null;

function formatNonError(obj) {
    var str;
    if (typeof obj === "function") {
        str = "[function " +
            (obj.name || "anonymous") +
            "]";
    } else {
        str = obj.toString();
        var ruselessToString = /\[object [a-zA-Z0-9$_]+\]/;
        if (ruselessToString.test(str)) {
            try {
                var newStr = JSON.stringify(obj);
                str = newStr;
            }
            catch(e) {

            }
        }
        if (str.length === 0) {
            str = "(empty array)";
        }
    }
    return ("(<" + snip(str) + ">, no stack trace)");
}

function snip(str) {
    var maxChars = 41;
    if (str.length < maxChars) {
        return str;
    }
    return str.substr(0, maxChars - 3) + "...";
}

function CapturedTrace(ignoreUntil, isTopLevel) {
    this.captureStackTrace(CapturedTrace, isTopLevel);

}
inherits(CapturedTrace, Error);

CapturedTrace.prototype.captureStackTrace =
function CapturedTrace$captureStackTrace(ignoreUntil, isTopLevel) {
    captureStackTrace(this, ignoreUntil, isTopLevel);
};

CapturedTrace.possiblyUnhandledRejection =
function CapturedTrace$PossiblyUnhandledRejection(reason) {
    if (typeof console === "object") {
        var message;
        if (typeof reason === "object" || typeof reason === "function") {
            var stack = reason.stack;
            message = "Possibly unhandled " + formatStack(stack, reason);
        } else {
            message = "Possibly unhandled " + String(reason);
        }
        if (typeof console.error === "function" ||
            typeof console.error === "object") {
            console.error(message);
        } else if (typeof console.log === "function" ||
            typeof console.log === "object") {
            console.log(message);
        }
    }
};

CapturedTrace.combine = function CapturedTrace$Combine(current, prev) {
    var currentLastIndex = current.length - 1;
    var currentLastLine = current[currentLastIndex];
    var commonRootMeetPoint = -1;
    for (var i = prev.length - 1; i >= 0; --i) {
        if (prev[i] === currentLastLine) {
            commonRootMeetPoint = i;
            break;
        }
    }

    for (var i = commonRootMeetPoint; i >= 0; --i) {
        var line = prev[i];
        if (current[currentLastIndex] === line) {
            current.pop();
            currentLastIndex--;
        } else {
            break;
        }
    }

    current.push("From previous event:");
    var lines = current.concat(prev);

    var ret = [];

    for (var i = 0, len = lines.length; i < len; ++i) {

        if (((rignore.test(lines[i]) && rtraceline.test(lines[i])) ||
            (i > 0 && !rtraceline.test(lines[i])) &&
            lines[i] !== "From previous event:")
       ) {
            continue;
        }
        ret.push(lines[i]);
    }
    return ret;
};

CapturedTrace.protectErrorMessageNewlines = function(stack) {
    for (var i = 0; i < stack.length; ++i) {
        if (rtraceline.test(stack[i])) {
            break;
        }
    }

    if (i <= 1) return;

    var errorMessageLines = [];
    for (var j = 0; j < i; ++j) {
        errorMessageLines.push(stack.shift());
    }
    stack.unshift(errorMessageLines.join("\u0002\u0000\u0001"));
};

CapturedTrace.isSupported = function CapturedTrace$IsSupported() {
    return typeof captureStackTrace === "function";
};

var captureStackTrace = (function stackDetection() {
    if (typeof Error.stackTraceLimit === "number" &&
        typeof Error.captureStackTrace === "function") {
        rtraceline = /^\s*at\s*/;
        formatStack = function(stack, error) {
            if (typeof stack === "string") return stack;

            if (error.name !== void 0 &&
                error.message !== void 0) {
                return error.name + ". " + error.message;
            }
            return formatNonError(error);


        };
        var captureStackTrace = Error.captureStackTrace;
        return function CapturedTrace$_captureStackTrace(
            receiver, ignoreUntil) {
            captureStackTrace(receiver, ignoreUntil);
        };
    }
    var err = new Error();

    if (typeof err.stack === "string" &&
        typeof "".startsWith === "function" &&
        (err.stack.startsWith("stackDetection@")) &&
        stackDetection.name === "stackDetection") {

        defineProperty(Error, "stackTraceLimit", {
            writable: true,
            enumerable: false,
            configurable: false,
            value: 25
        });
        rtraceline = /@/;
        var rline = /[@\n]/;

        formatStack = function(stack, error) {
            if (typeof stack === "string") {
                return (error.name + ". " + error.message + "\n" + stack);
            }

            if (error.name !== void 0 &&
                error.message !== void 0) {
                return error.name + ". " + error.message;
            }
            return formatNonError(error);
        };

        return function captureStackTrace(o) {
            var stack = new Error().stack;
            var split = stack.split(rline);
            var len = split.length;
            var ret = "";
            for (var i = 0; i < len; i += 2) {
                ret += split[i];
                ret += "@";
                ret += split[i + 1];
                ret += "\n";
            }
            o.stack = ret;
        };
    } else {
        formatStack = function(stack, error) {
            if (typeof stack === "string") return stack;

            if ((typeof error === "object" ||
                typeof error === "function") &&
                error.name !== void 0 &&
                error.message !== void 0) {
                return error.name + ". " + error.message;
            }
            return formatNonError(error);
        };

        return null;
    }
})();

return CapturedTrace;
};

},{"./es5.js":17,"./util.js":40}],12:[function(require,module,exports){
/**
 * The MIT License (MIT)
 * 
 * Copyright (c) 2014 Petka Antonov
 * 
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:</p>
 * 
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * 
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.  IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 * 
 */
"use strict";
module.exports = function(NEXT_FILTER) {
var util = require("./util.js");
var errors = require("./errors.js");
var tryCatch1 = util.tryCatch1;
var errorObj = util.errorObj;
var keys = require("./es5.js").keys;
var TypeError = errors.TypeError;

function CatchFilter(instances, callback, promise) {
    this._instances = instances;
    this._callback = callback;
    this._promise = promise;
}

function CatchFilter$_safePredicate(predicate, e) {
    var safeObject = {};
    var retfilter = tryCatch1(predicate, safeObject, e);

    if (retfilter === errorObj) return retfilter;

    var safeKeys = keys(safeObject);
    if (safeKeys.length) {
        errorObj.e = new TypeError(
            "Catch filter must inherit from Error "
          + "or be a simple predicate function");
        return errorObj;
    }
    return retfilter;
}

CatchFilter.prototype.doFilter = function CatchFilter$_doFilter(e) {
    var cb = this._callback;
    var promise = this._promise;
    var boundTo = promise._boundTo;
    for (var i = 0, len = this._instances.length; i < len; ++i) {
        var item = this._instances[i];
        var itemIsErrorType = item === Error ||
            (item != null && item.prototype instanceof Error);

        if (itemIsErrorType && e instanceof item) {
            var ret = tryCatch1(cb, boundTo, e);
            if (ret === errorObj) {
                NEXT_FILTER.e = ret.e;
                return NEXT_FILTER;
            }
            return ret;
        } else if (typeof item === "function" && !itemIsErrorType) {
            var shouldHandle = CatchFilter$_safePredicate(item, e);
            if (shouldHandle === errorObj) {
                var trace = errors.canAttach(errorObj.e)
                    ? errorObj.e
                    : new Error(errorObj.e + "");
                this._promise._attachExtraTrace(trace);
                e = errorObj.e;
                break;
            } else if (shouldHandle) {
                var ret = tryCatch1(cb, boundTo, e);
                if (ret === errorObj) {
                    NEXT_FILTER.e = ret.e;
                    return NEXT_FILTER;
                }
                return ret;
            }
        }
    }
    NEXT_FILTER.e = e;
    return NEXT_FILTER;
};

return CatchFilter;
};

},{"./errors.js":15,"./es5.js":17,"./util.js":40}],13:[function(require,module,exports){
/**
 * The MIT License (MIT)
 * 
 * Copyright (c) 2014 Petka Antonov
 * 
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:</p>
 * 
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * 
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.  IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 * 
 */
"use strict";
var util = require("./util.js");
var isPrimitive = util.isPrimitive;
var wrapsPrimitiveReceiver = util.wrapsPrimitiveReceiver;

module.exports = function(Promise) {
var returner = function Promise$_returner() {
    return this;
};
var thrower = function Promise$_thrower() {
    throw this;
};

var wrapper = function Promise$_wrapper(value, action) {
    if (action === 1) {
        return function Promise$_thrower() {
            throw value;
        };
    } else if (action === 2) {
        return function Promise$_returner() {
            return value;
        };
    }
};


Promise.prototype["return"] =
Promise.prototype.thenReturn =
function Promise$thenReturn(value) {
    if (wrapsPrimitiveReceiver && isPrimitive(value)) {
        return this._then(
            wrapper(value, 2),
            void 0,
            void 0,
            void 0,
            void 0
       );
    }
    return this._then(returner, void 0, void 0, value, void 0);
};

Promise.prototype["throw"] =
Promise.prototype.thenThrow =
function Promise$thenThrow(reason) {
    if (wrapsPrimitiveReceiver && isPrimitive(reason)) {
        return this._then(
            wrapper(reason, 1),
            void 0,
            void 0,
            void 0,
            void 0
       );
    }
    return this._then(thrower, void 0, void 0, reason, void 0);
};
};

},{"./util.js":40}],14:[function(require,module,exports){
/**
 * The MIT License (MIT)
 * 
 * Copyright (c) 2014 Petka Antonov
 * 
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:</p>
 * 
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * 
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.  IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 * 
 */
"use strict";
module.exports = function(Promise, INTERNAL) {
var PromiseReduce = Promise.reduce;

Promise.prototype.each = function Promise$each(fn) {
    return PromiseReduce(this, fn, null, INTERNAL);
};

Promise.each = function Promise$Each(promises, fn) {
    return PromiseReduce(promises, fn, null, INTERNAL);
};
};

},{}],15:[function(require,module,exports){
/**
 * The MIT License (MIT)
 * 
 * Copyright (c) 2014 Petka Antonov
 * 
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:</p>
 * 
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * 
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.  IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 * 
 */
"use strict";
var Objectfreeze = require("./es5.js").freeze;
var util = require("./util.js");
var inherits = util.inherits;
var notEnumerableProp = util.notEnumerableProp;

function markAsOriginatingFromRejection(e) {
    try {
        notEnumerableProp(e, "isOperational", true);
    }
    catch(ignore) {}
}

function originatesFromRejection(e) {
    if (e == null) return false;
    return ((e instanceof OperationalError) ||
        e["isOperational"] === true);
}

function isError(obj) {
    return obj instanceof Error;
}

function canAttach(obj) {
    return isError(obj);
}

function subError(nameProperty, defaultMessage) {
    function SubError(message) {
        if (!(this instanceof SubError)) return new SubError(message);
        this.message = typeof message === "string" ? message : defaultMessage;
        this.name = nameProperty;
        if (Error.captureStackTrace) {
            Error.captureStackTrace(this, this.constructor);
        }
    }
    inherits(SubError, Error);
    return SubError;
}

var _TypeError, _RangeError;
var CancellationError = subError("CancellationError", "cancellation error");
var TimeoutError = subError("TimeoutError", "timeout error");
var AggregateError = subError("AggregateError", "aggregate error");
try {
    _TypeError = TypeError;
    _RangeError = RangeError;
} catch(e) {
    _TypeError = subError("TypeError", "type error");
    _RangeError = subError("RangeError", "range error");
}

var methods = ("join pop push shift unshift slice filter forEach some " +
    "every map indexOf lastIndexOf reduce reduceRight sort reverse").split(" ");

for (var i = 0; i < methods.length; ++i) {
    if (typeof Array.prototype[methods[i]] === "function") {
        AggregateError.prototype[methods[i]] = Array.prototype[methods[i]];
    }
}

AggregateError.prototype.length = 0;
AggregateError.prototype["isOperational"] = true;
var level = 0;
AggregateError.prototype.toString = function() {
    var indent = Array(level * 4 + 1).join(" ");
    var ret = "\n" + indent + "AggregateError of:" + "\n";
    level++;
    indent = Array(level * 4 + 1).join(" ");
    for (var i = 0; i < this.length; ++i) {
        var str = this[i] === this ? "[Circular AggregateError]" : this[i] + "";
        var lines = str.split("\n");
        for (var j = 0; j < lines.length; ++j) {
            lines[j] = indent + lines[j];
        }
        str = lines.join("\n");
        ret += str + "\n";
    }
    level--;
    return ret;
};

function OperationalError(message) {
    this.name = "OperationalError";
    this.message = message;
    this.cause = message;
    this["isOperational"] = true;

    if (message instanceof Error) {
        this.message = message.message;
        this.stack = message.stack;
    } else if (Error.captureStackTrace) {
        Error.captureStackTrace(this, this.constructor);
    }

}
inherits(OperationalError, Error);

var key = "__BluebirdErrorTypes__";
var errorTypes = Error[key];
if (!errorTypes) {
    errorTypes = Objectfreeze({
        CancellationError: CancellationError,
        TimeoutError: TimeoutError,
        OperationalError: OperationalError,
        RejectionError: OperationalError,
        AggregateError: AggregateError
    });
    notEnumerableProp(Error, key, errorTypes);
}

module.exports = {
    Error: Error,
    TypeError: _TypeError,
    RangeError: _RangeError,
    CancellationError: errorTypes.CancellationError,
    OperationalError: errorTypes.OperationalError,
    TimeoutError: errorTypes.TimeoutError,
    AggregateError: errorTypes.AggregateError,
    originatesFromRejection: originatesFromRejection,
    markAsOriginatingFromRejection: markAsOriginatingFromRejection,
    canAttach: canAttach
};

},{"./es5.js":17,"./util.js":40}],16:[function(require,module,exports){
/**
 * The MIT License (MIT)
 * 
 * Copyright (c) 2014 Petka Antonov
 * 
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:</p>
 * 
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * 
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.  IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 * 
 */
"use strict";
module.exports = function(Promise) {
var TypeError = require('./errors.js').TypeError;

function apiRejection(msg) {
    var error = new TypeError(msg);
    var ret = Promise.rejected(error);
    var parent = ret._peekContext();
    if (parent != null) {
        parent._attachExtraTrace(error);
    }
    return ret;
}

return apiRejection;
};

},{"./errors.js":15}],17:[function(require,module,exports){
/**
 * The MIT License (MIT)
 * 
 * Copyright (c) 2014 Petka Antonov
 * 
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:</p>
 * 
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * 
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.  IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 * 
 */
var isES5 = (function(){
    "use strict";
    return this === void 0;
})();

if (isES5) {
    module.exports = {
        freeze: Object.freeze,
        defineProperty: Object.defineProperty,
        keys: Object.keys,
        getPrototypeOf: Object.getPrototypeOf,
        isArray: Array.isArray,
        isES5: isES5
    };
} else {
    var has = {}.hasOwnProperty;
    var str = {}.toString;
    var proto = {}.constructor.prototype;

    var ObjectKeys = function ObjectKeys(o) {
        var ret = [];
        for (var key in o) {
            if (has.call(o, key)) {
                ret.push(key);
            }
        }
        return ret;
    }

    var ObjectDefineProperty = function ObjectDefineProperty(o, key, desc) {
        o[key] = desc.value;
        return o;
    }

    var ObjectFreeze = function ObjectFreeze(obj) {
        return obj;
    }

    var ObjectGetPrototypeOf = function ObjectGetPrototypeOf(obj) {
        try {
            return Object(obj).constructor.prototype;
        }
        catch (e) {
            return proto;
        }
    }

    var ArrayIsArray = function ArrayIsArray(obj) {
        try {
            return str.call(obj) === "[object Array]";
        }
        catch(e) {
            return false;
        }
    }

    module.exports = {
        isArray: ArrayIsArray,
        keys: ObjectKeys,
        defineProperty: ObjectDefineProperty,
        freeze: ObjectFreeze,
        getPrototypeOf: ObjectGetPrototypeOf,
        isES5: isES5
    };
}

},{}],18:[function(require,module,exports){
/**
 * The MIT License (MIT)
 * 
 * Copyright (c) 2014 Petka Antonov
 * 
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:</p>
 * 
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * 
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.  IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 * 
 */
"use strict";
module.exports = function(Promise, INTERNAL) {
var PromiseMap = Promise.map;

Promise.prototype.filter = function Promise$filter(fn, options) {
    return PromiseMap(this, fn, options, INTERNAL);
};

Promise.filter = function Promise$Filter(promises, fn, options) {
    return PromiseMap(promises, fn, options, INTERNAL);
};
};

},{}],19:[function(require,module,exports){
/**
 * The MIT License (MIT)
 * 
 * Copyright (c) 2014 Petka Antonov
 * 
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:</p>
 * 
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * 
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.  IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 * 
 */
"use strict";
module.exports = function(Promise, NEXT_FILTER, cast) {
var util = require("./util.js");
var wrapsPrimitiveReceiver = util.wrapsPrimitiveReceiver;
var isPrimitive = util.isPrimitive;
var thrower = util.thrower;

function returnThis() {
    return this;
}
function throwThis() {
    throw this;
}
function return$(r) {
    return function Promise$_returner() {
        return r;
    };
}
function throw$(r) {
    return function Promise$_thrower() {
        throw r;
    };
}
function promisedFinally(ret, reasonOrValue, isFulfilled) {
    var then;
    if (wrapsPrimitiveReceiver && isPrimitive(reasonOrValue)) {
        then = isFulfilled ? return$(reasonOrValue) : throw$(reasonOrValue);
    } else {
        then = isFulfilled ? returnThis : throwThis;
    }
    return ret._then(then, thrower, void 0, reasonOrValue, void 0);
}

function finallyHandler(reasonOrValue) {
    var promise = this.promise;
    var handler = this.handler;

    var ret = promise._isBound()
                    ? handler.call(promise._boundTo)
                    : handler();

    if (ret !== void 0) {
        var maybePromise = cast(ret, void 0);
        if (maybePromise instanceof Promise) {
            return promisedFinally(maybePromise, reasonOrValue,
                                    promise.isFulfilled());
        }
    }

    if (promise.isRejected()) {
        NEXT_FILTER.e = reasonOrValue;
        return NEXT_FILTER;
    } else {
        return reasonOrValue;
    }
}

function tapHandler(value) {
    var promise = this.promise;
    var handler = this.handler;

    var ret = promise._isBound()
                    ? handler.call(promise._boundTo, value)
                    : handler(value);

    if (ret !== void 0) {
        var maybePromise = cast(ret, void 0);
        if (maybePromise instanceof Promise) {
            return promisedFinally(maybePromise, value, true);
        }
    }
    return value;
}

Promise.prototype._passThroughHandler =
function Promise$_passThroughHandler(handler, isFinally) {
    if (typeof handler !== "function") return this.then();

    var promiseAndHandler = {
        promise: this,
        handler: handler
    };

    return this._then(
            isFinally ? finallyHandler : tapHandler,
            isFinally ? finallyHandler : void 0, void 0,
            promiseAndHandler, void 0);
};

Promise.prototype.lastly =
Promise.prototype["finally"] = function Promise$finally(handler) {
    return this._passThroughHandler(handler, true);
};

Promise.prototype.tap = function Promise$tap(handler) {
    return this._passThroughHandler(handler, false);
};
};

},{"./util.js":40}],20:[function(require,module,exports){
/**
 * The MIT License (MIT)
 * 
 * Copyright (c) 2014 Petka Antonov
 * 
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:</p>
 * 
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * 
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.  IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 * 
 */
"use strict";
module.exports = function(Promise, apiRejection, INTERNAL, cast) {
var errors = require("./errors.js");
var TypeError = errors.TypeError;
var deprecated = require("./util.js").deprecated;
var util = require("./util.js");
var errorObj = util.errorObj;
var tryCatch1 = util.tryCatch1;
var yieldHandlers = [];

function promiseFromYieldHandler(value, yieldHandlers) {
    var _errorObj = errorObj;
    var _Promise = Promise;
    var len = yieldHandlers.length;
    for (var i = 0; i < len; ++i) {
        var result = tryCatch1(yieldHandlers[i], void 0, value);
        if (result === _errorObj) {
            return _Promise.reject(_errorObj.e);
        }
        var maybePromise = cast(result, promiseFromYieldHandler);
        if (maybePromise instanceof _Promise) return maybePromise;
    }
    return null;
}

function PromiseSpawn(generatorFunction, receiver, yieldHandler) {
    var promise = this._promise = new Promise(INTERNAL);
    promise._setTrace(void 0);
    this._generatorFunction = generatorFunction;
    this._receiver = receiver;
    this._generator = void 0;
    this._yieldHandlers = typeof yieldHandler === "function"
        ? [yieldHandler].concat(yieldHandlers)
        : yieldHandlers;
}

PromiseSpawn.prototype.promise = function PromiseSpawn$promise() {
    return this._promise;
};

PromiseSpawn.prototype._run = function PromiseSpawn$_run() {
    this._generator = this._generatorFunction.call(this._receiver);
    this._receiver =
        this._generatorFunction = void 0;
    this._next(void 0);
};

PromiseSpawn.prototype._continue = function PromiseSpawn$_continue(result) {
    if (result === errorObj) {
        this._generator = void 0;
        var trace = errors.canAttach(result.e)
            ? result.e : new Error(result.e + "");
        this._promise._attachExtraTrace(trace);
        this._promise._reject(result.e, trace);
        return;
    }

    var value = result.value;
    if (result.done === true) {
        this._generator = void 0;
        if (!this._promise._tryFollow(value)) {
            this._promise._fulfill(value);
        }
    } else {
        var maybePromise = cast(value, void 0);
        if (!(maybePromise instanceof Promise)) {
            maybePromise =
                promiseFromYieldHandler(maybePromise, this._yieldHandlers);
            if (maybePromise === null) {
                this._throw(new TypeError("A value was yielded that could not be treated as a promise"));
                return;
            }
        }
        maybePromise._then(
            this._next,
            this._throw,
            void 0,
            this,
            null
       );
    }
};

PromiseSpawn.prototype._throw = function PromiseSpawn$_throw(reason) {
    if (errors.canAttach(reason))
        this._promise._attachExtraTrace(reason);
    this._continue(
        tryCatch1(this._generator["throw"], this._generator, reason)
   );
};

PromiseSpawn.prototype._next = function PromiseSpawn$_next(value) {
    this._continue(
        tryCatch1(this._generator.next, this._generator, value)
   );
};

Promise.coroutine =
function Promise$Coroutine(generatorFunction, options) {
    if (typeof generatorFunction !== "function") {
        throw new TypeError("generatorFunction must be a function");
    }
    var yieldHandler = Object(options).yieldHandler;
    var PromiseSpawn$ = PromiseSpawn;
    return function () {
        var generator = generatorFunction.apply(this, arguments);
        var spawn = new PromiseSpawn$(void 0, void 0, yieldHandler);
        spawn._generator = generator;
        spawn._next(void 0);
        return spawn.promise();
    };
};

Promise.coroutine.addYieldHandler = function(fn) {
    if (typeof fn !== "function") throw new TypeError("fn must be a function");
    yieldHandlers.push(fn);
};

Promise.spawn = function Promise$Spawn(generatorFunction) {
    deprecated("Promise.spawn is deprecated. Use Promise.coroutine instead.");
    if (typeof generatorFunction !== "function") {
        return apiRejection("generatorFunction must be a function");
    }
    var spawn = new PromiseSpawn(generatorFunction, this);
    var ret = spawn.promise();
    spawn._run(Promise.spawn);
    return ret;
};
};

},{"./errors.js":15,"./util.js":40}],21:[function(require,module,exports){
/**
 * The MIT License (MIT)
 * 
 * Copyright (c) 2014 Petka Antonov
 * 
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:</p>
 * 
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * 
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.  IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 * 
 */
"use strict";
module.exports =
function(Promise, PromiseArray, cast, INTERNAL) {
var util = require("./util.js");
var canEvaluate = util.canEvaluate;
var tryCatch1 = util.tryCatch1;
var errorObj = util.errorObj;


if (canEvaluate) {
    var thenCallback = function(i) {
        return new Function("value", "holder", "                             \n\
            'use strict';                                                    \n\
            holder.pIndex = value;                                           \n\
            holder.checkFulfillment(this);                                   \n\
            ".replace(/Index/g, i));
    };

    var caller = function(count) {
        var values = [];
        for (var i = 1; i <= count; ++i) values.push("holder.p" + i);
        return new Function("holder", "                                      \n\
            'use strict';                                                    \n\
            var callback = holder.fn;                                        \n\
            return callback(values);                                         \n\
            ".replace(/values/g, values.join(", ")));
    };
    var thenCallbacks = [];
    var callers = [void 0];
    for (var i = 1; i <= 5; ++i) {
        thenCallbacks.push(thenCallback(i));
        callers.push(caller(i));
    }

    var Holder = function(total, fn) {
        this.p1 = this.p2 = this.p3 = this.p4 = this.p5 = null;
        this.fn = fn;
        this.total = total;
        this.now = 0;
    };

    Holder.prototype.callers = callers;
    Holder.prototype.checkFulfillment = function(promise) {
        var now = this.now;
        now++;
        var total = this.total;
        if (now >= total) {
            var handler = this.callers[total];
            var ret = tryCatch1(handler, void 0, this);
            if (ret === errorObj) {
                promise._rejectUnchecked(ret.e);
            } else if (!promise._tryFollow(ret)) {
                promise._fulfillUnchecked(ret);
            }
        } else {
            this.now = now;
        }
    };
}

function reject(reason) {
    this._reject(reason);
}

Promise.join = function Promise$Join() {
    var last = arguments.length - 1;
    var fn;
    if (last > 0 && typeof arguments[last] === "function") {
        fn = arguments[last];
        if (last < 6 && canEvaluate) {
            var ret = new Promise(INTERNAL);
            ret._setTrace(void 0);
            var holder = new Holder(last, fn);
            var callbacks = thenCallbacks;
            for (var i = 0; i < last; ++i) {
                var maybePromise = cast(arguments[i], void 0);
                if (maybePromise instanceof Promise) {
                    if (maybePromise.isPending()) {
                        maybePromise._then(callbacks[i], reject,
                                           void 0, ret, holder);
                    } else if (maybePromise.isFulfilled()) {
                        callbacks[i].call(ret,
                                          maybePromise._settledValue, holder);
                    } else {
                        ret._reject(maybePromise._settledValue);
                        maybePromise._unsetRejectionIsUnhandled();
                    }
                } else {
                    callbacks[i].call(ret, maybePromise, holder);
                }
            }
            return ret;
        }
    }
    var $_len = arguments.length;var args = new Array($_len); for(var $_i = 0; $_i < $_len; ++$_i) {args[$_i] = arguments[$_i];}
    var ret = new PromiseArray(args).promise();
    return fn !== void 0 ? ret.spread(fn) : ret;
};

};

},{"./util.js":40}],22:[function(require,module,exports){
/**
 * The MIT License (MIT)
 * 
 * Copyright (c) 2014 Petka Antonov
 * 
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:</p>
 * 
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * 
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.  IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 * 
 */
"use strict";
module.exports = function(Promise, PromiseArray, apiRejection, cast, INTERNAL) {
var util = require("./util.js");
var tryCatch3 = util.tryCatch3;
var errorObj = util.errorObj;
var PENDING = {};
var EMPTY_ARRAY = [];

function MappingPromiseArray(promises, fn, limit, _filter) {
    this.constructor$(promises);
    this._callback = fn;
    this._preservedValues = _filter === INTERNAL
        ? new Array(this.length())
        : null;
    this._limit = limit;
    this._inFlight = 0;
    this._queue = limit >= 1 ? [] : EMPTY_ARRAY;
    this._init$(void 0, -2);
}
util.inherits(MappingPromiseArray, PromiseArray);

MappingPromiseArray.prototype._init = function MappingPromiseArray$_init() {};

MappingPromiseArray.prototype._promiseFulfilled =
function MappingPromiseArray$_promiseFulfilled(value, index) {
    var values = this._values;
    if (values === null) return;

    var length = this.length();
    var preservedValues = this._preservedValues;
    var limit = this._limit;
    if (values[index] === PENDING) {
        values[index] = value;
        if (limit >= 1) {
            this._inFlight--;
            this._drainQueue();
            if (this._isResolved()) return;
        }
    } else {
        if (limit >= 1 && this._inFlight >= limit) {
            values[index] = value;
            this._queue.push(index);
            return;
        }
        if (preservedValues !== null) preservedValues[index] = value;

        var callback = this._callback;
        var receiver = this._promise._boundTo;
        var ret = tryCatch3(callback, receiver, value, index, length);
        if (ret === errorObj) return this._reject(ret.e);

        var maybePromise = cast(ret, void 0);
        if (maybePromise instanceof Promise) {
            if (maybePromise.isPending()) {
                if (limit >= 1) this._inFlight++;
                values[index] = PENDING;
                return maybePromise._proxyPromiseArray(this, index);
            } else if (maybePromise.isFulfilled()) {
                ret = maybePromise.value();
            } else {
                maybePromise._unsetRejectionIsUnhandled();
                return this._reject(maybePromise.reason());
            }
        }
        values[index] = ret;
    }
    var totalResolved = ++this._totalResolved;
    if (totalResolved >= length) {
        if (preservedValues !== null) {
            this._filter(values, preservedValues);
        } else {
            this._resolve(values);
        }

    }
};

MappingPromiseArray.prototype._drainQueue =
function MappingPromiseArray$_drainQueue() {
    var queue = this._queue;
    var limit = this._limit;
    var values = this._values;
    while (queue.length > 0 && this._inFlight < limit) {
        var index = queue.pop();
        this._promiseFulfilled(values[index], index);
    }
};

MappingPromiseArray.prototype._filter =
function MappingPromiseArray$_filter(booleans, values) {
    var len = values.length;
    var ret = new Array(len);
    var j = 0;
    for (var i = 0; i < len; ++i) {
        if (booleans[i]) ret[j++] = values[i];
    }
    ret.length = j;
    this._resolve(ret);
};

MappingPromiseArray.prototype.preservedValues =
function MappingPromiseArray$preserveValues() {
    return this._preservedValues;
};

function map(promises, fn, options, _filter) {
    var limit = typeof options === "object" && options !== null
        ? options.concurrency
        : 0;
    limit = typeof limit === "number" &&
        isFinite(limit) && limit >= 1 ? limit : 0;
    return new MappingPromiseArray(promises, fn, limit, _filter);
}

Promise.prototype.map = function Promise$map(fn, options) {
    if (typeof fn !== "function") return apiRejection("fn must be a function");

    return map(this, fn, options, null).promise();
};

Promise.map = function Promise$Map(promises, fn, options, _filter) {
    if (typeof fn !== "function") return apiRejection("fn must be a function");
    return map(promises, fn, options, _filter).promise();
};


};

},{"./util.js":40}],23:[function(require,module,exports){
/**
 * The MIT License (MIT)
 * 
 * Copyright (c) 2014 Petka Antonov
 * 
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:</p>
 * 
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * 
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.  IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 * 
 */
"use strict";
module.exports = function(Promise) {
var util = require("./util.js");
var async = require("./async.js");
var tryCatch2 = util.tryCatch2;
var tryCatch1 = util.tryCatch1;
var errorObj = util.errorObj;

function thrower(r) {
    throw r;
}

function Promise$_spreadAdapter(val, receiver) {
    if (!util.isArray(val)) return Promise$_successAdapter(val, receiver);
    var ret = util.tryCatchApply(this, [null].concat(val), receiver);
    if (ret === errorObj) {
        async.invokeLater(thrower, void 0, ret.e);
    }
}

function Promise$_successAdapter(val, receiver) {
    var nodeback = this;
    var ret = val === void 0
        ? tryCatch1(nodeback, receiver, null)
        : tryCatch2(nodeback, receiver, null, val);
    if (ret === errorObj) {
        async.invokeLater(thrower, void 0, ret.e);
    }
}
function Promise$_errorAdapter(reason, receiver) {
    var nodeback = this;
    var ret = tryCatch1(nodeback, receiver, reason);
    if (ret === errorObj) {
        async.invokeLater(thrower, void 0, ret.e);
    }
}

Promise.prototype.nodeify = function Promise$nodeify(nodeback, options) {
    if (typeof nodeback == "function") {
        var adapter = Promise$_successAdapter;
        if (options !== void 0 && Object(options).spread) {
            adapter = Promise$_spreadAdapter;
        }
        this._then(
            adapter,
            Promise$_errorAdapter,
            void 0,
            nodeback,
            this._boundTo
        );
    }
    return this;
};
};

},{"./async.js":7,"./util.js":40}],24:[function(require,module,exports){
/**
 * The MIT License (MIT)
 * 
 * Copyright (c) 2014 Petka Antonov
 * 
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:</p>
 * 
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * 
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.  IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 * 
 */
"use strict";
module.exports = function(Promise, PromiseArray) {
var util = require("./util.js");
var async = require("./async.js");
var errors = require("./errors.js");
var tryCatch1 = util.tryCatch1;
var errorObj = util.errorObj;

Promise.prototype.progressed = function Promise$progressed(handler) {
    return this._then(void 0, void 0, handler, void 0, void 0);
};

Promise.prototype._progress = function Promise$_progress(progressValue) {
    if (this._isFollowingOrFulfilledOrRejected()) return;
    this._progressUnchecked(progressValue);

};

Promise.prototype._clearFirstHandlerData$Base =
Promise.prototype._clearFirstHandlerData;
Promise.prototype._clearFirstHandlerData =
function Promise$_clearFirstHandlerData() {
    this._clearFirstHandlerData$Base();
    this._progressHandler0 = void 0;
};

Promise.prototype._progressHandlerAt =
function Promise$_progressHandlerAt(index) {
    return index === 0
        ? this._progressHandler0
        : this[(index << 2) + index - 5 + 2];
};

Promise.prototype._doProgressWith =
function Promise$_doProgressWith(progression) {
    var progressValue = progression.value;
    var handler = progression.handler;
    var promise = progression.promise;
    var receiver = progression.receiver;

    var ret = tryCatch1(handler, receiver, progressValue);
    if (ret === errorObj) {
        if (ret.e != null &&
            ret.e.name !== "StopProgressPropagation") {
            var trace = errors.canAttach(ret.e)
                ? ret.e : new Error(ret.e + "");
            promise._attachExtraTrace(trace);
            promise._progress(ret.e);
        }
    } else if (ret instanceof Promise) {
        ret._then(promise._progress, null, null, promise, void 0);
    } else {
        promise._progress(ret);
    }
};


Promise.prototype._progressUnchecked =
function Promise$_progressUnchecked(progressValue) {
    if (!this.isPending()) return;
    var len = this._length();
    var progress = this._progress;
    for (var i = 0; i < len; i++) {
        var handler = this._progressHandlerAt(i);
        var promise = this._promiseAt(i);
        if (!(promise instanceof Promise)) {
            var receiver = this._receiverAt(i);
            if (typeof handler === "function") {
                handler.call(receiver, progressValue, promise);
            } else if (receiver instanceof Promise && receiver._isProxied()) {
                receiver._progressUnchecked(progressValue);
            } else if (receiver instanceof PromiseArray) {
                receiver._promiseProgressed(progressValue, promise);
            }
            continue;
        }

        if (typeof handler === "function") {
            async.invoke(this._doProgressWith, this, {
                handler: handler,
                promise: promise,
                receiver: this._receiverAt(i),
                value: progressValue
            });
        } else {
            async.invoke(progress, promise, progressValue);
        }
    }
};
};

},{"./async.js":7,"./errors.js":15,"./util.js":40}],25:[function(require,module,exports){
(function (process){
/**
 * The MIT License (MIT)
 * 
 * Copyright (c) 2014 Petka Antonov
 * 
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:</p>
 * 
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * 
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.  IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 * 
 */
"use strict";
var old;
if (typeof Promise !== "undefined") old = Promise;
function noConflict(bluebird) {
    try { if (Promise === bluebird) Promise = old; }
    catch (e) {}
    return bluebird;
}
module.exports = function() {
var util = require("./util.js");
var async = require("./async.js");
var errors = require("./errors.js");

var INTERNAL = function(){};
var APPLY = {};
var NEXT_FILTER = {e: null};

var cast = require("./thenables.js")(Promise, INTERNAL);
var PromiseArray = require("./promise_array.js")(Promise, INTERNAL, cast);
var CapturedTrace = require("./captured_trace.js")();
var CatchFilter = require("./catch_filter.js")(NEXT_FILTER);
var PromiseResolver = require("./promise_resolver.js");

var isArray = util.isArray;

var errorObj = util.errorObj;
var tryCatch1 = util.tryCatch1;
var tryCatch2 = util.tryCatch2;
var tryCatchApply = util.tryCatchApply;
var RangeError = errors.RangeError;
var TypeError = errors.TypeError;
var CancellationError = errors.CancellationError;
var TimeoutError = errors.TimeoutError;
var OperationalError = errors.OperationalError;
var originatesFromRejection = errors.originatesFromRejection;
var markAsOriginatingFromRejection = errors.markAsOriginatingFromRejection;
var canAttach = errors.canAttach;
var thrower = util.thrower;
var apiRejection = require("./errors_api_rejection")(Promise);


var makeSelfResolutionError = function Promise$_makeSelfResolutionError() {
    return new TypeError("circular promise resolution chain");
};

function Promise(resolver) {
    if (typeof resolver !== "function") {
        throw new TypeError("the promise constructor requires a resolver function");
    }
    if (this.constructor !== Promise) {
        throw new TypeError("the promise constructor cannot be invoked directly");
    }
    this._bitField = 0;
    this._fulfillmentHandler0 = void 0;
    this._rejectionHandler0 = void 0;
    this._promise0 = void 0;
    this._receiver0 = void 0;
    this._settledValue = void 0;
    this._boundTo = void 0;
    if (resolver !== INTERNAL) this._resolveFromResolver(resolver);
}

function returnFirstElement(elements) {
    return elements[0];
}

Promise.prototype.bind = function Promise$bind(thisArg) {
    var maybePromise = cast(thisArg, void 0);
    var ret = new Promise(INTERNAL);
    if (maybePromise instanceof Promise) {
        var binder = maybePromise.then(function(thisArg) {
            ret._setBoundTo(thisArg);
        });
        var p = Promise.all([this, binder]).then(returnFirstElement);
        ret._follow(p);
    } else {
        ret._follow(this);
        ret._setBoundTo(thisArg);
    }
    ret._propagateFrom(this, 2 | 1);
    return ret;
};

Promise.prototype.toString = function Promise$toString() {
    return "[object Promise]";
};

Promise.prototype.caught = Promise.prototype["catch"] =
function Promise$catch(fn) {
    var len = arguments.length;
    if (len > 1) {
        var catchInstances = new Array(len - 1),
            j = 0, i;
        for (i = 0; i < len - 1; ++i) {
            var item = arguments[i];
            if (typeof item === "function") {
                catchInstances[j++] = item;
            } else {
                var catchFilterTypeError =
                    new TypeError(
                        "A catch filter must be an error constructor "
                        + "or a filter function");

                this._attachExtraTrace(catchFilterTypeError);
                return Promise.reject(catchFilterTypeError);
            }
        }
        catchInstances.length = j;
        fn = arguments[i];

        this._resetTrace();
        var catchFilter = new CatchFilter(catchInstances, fn, this);
        return this._then(void 0, catchFilter.doFilter, void 0,
            catchFilter, void 0);
    }
    return this._then(void 0, fn, void 0, void 0, void 0);
};

function reflect() {
    return new Promise.PromiseInspection(this);
}

Promise.prototype.reflect = function Promise$reflect() {
    return this._then(reflect, reflect, void 0, this, void 0);
};

Promise.prototype.then =
function Promise$then(didFulfill, didReject, didProgress) {
    return this._then(didFulfill, didReject, didProgress,
        void 0, void 0);
};


Promise.prototype.done =
function Promise$done(didFulfill, didReject, didProgress) {
    var promise = this._then(didFulfill, didReject, didProgress,
        void 0, void 0);
    promise._setIsFinal();
};

Promise.prototype.spread = function Promise$spread(didFulfill, didReject) {
    return this._then(didFulfill, didReject, void 0,
        APPLY, void 0);
};

Promise.prototype.isCancellable = function Promise$isCancellable() {
    return !this.isResolved() &&
        this._cancellable();
};

Promise.prototype.toJSON = function Promise$toJSON() {
    var ret = {
        isFulfilled: false,
        isRejected: false,
        fulfillmentValue: void 0,
        rejectionReason: void 0
    };
    if (this.isFulfilled()) {
        ret.fulfillmentValue = this._settledValue;
        ret.isFulfilled = true;
    } else if (this.isRejected()) {
        ret.rejectionReason = this._settledValue;
        ret.isRejected = true;
    }
    return ret;
};

Promise.prototype.all = function Promise$all() {
    return new PromiseArray(this).promise();
};


Promise.is = function Promise$Is(val) {
    return val instanceof Promise;
};

Promise.all = function Promise$All(promises) {
    return new PromiseArray(promises).promise();
};

Promise.prototype.error = function Promise$_error(fn) {
    return this.caught(originatesFromRejection, fn);
};

Promise.prototype._resolveFromSyncValue =
function Promise$_resolveFromSyncValue(value) {
    if (value === errorObj) {
        this._cleanValues();
        this._setRejected();
        var reason = value.e;
        this._settledValue = reason;
        this._tryAttachExtraTrace(reason);
        this._ensurePossibleRejectionHandled();
    } else {
        var maybePromise = cast(value, void 0);
        if (maybePromise instanceof Promise) {
            this._follow(maybePromise);
        } else {
            this._cleanValues();
            this._setFulfilled();
            this._settledValue = value;
        }
    }
};

Promise.method = function Promise$_Method(fn) {
    if (typeof fn !== "function") {
        throw new TypeError("fn must be a function");
    }
    return function Promise$_method() {
        var value;
        switch(arguments.length) {
        case 0: value = tryCatch1(fn, this, void 0); break;
        case 1: value = tryCatch1(fn, this, arguments[0]); break;
        case 2: value = tryCatch2(fn, this, arguments[0], arguments[1]); break;
        default:
            var $_len = arguments.length;var args = new Array($_len); for(var $_i = 0; $_i < $_len; ++$_i) {args[$_i] = arguments[$_i];}
            value = tryCatchApply(fn, args, this); break;
        }
        var ret = new Promise(INTERNAL);
        ret._setTrace(void 0);
        ret._resolveFromSyncValue(value);
        return ret;
    };
};

Promise.attempt = Promise["try"] = function Promise$_Try(fn, args, ctx) {
    if (typeof fn !== "function") {
        return apiRejection("fn must be a function");
    }
    var value = isArray(args)
        ? tryCatchApply(fn, args, ctx)
        : tryCatch1(fn, ctx, args);

    var ret = new Promise(INTERNAL);
    ret._setTrace(void 0);
    ret._resolveFromSyncValue(value);
    return ret;
};

Promise.defer = Promise.pending = function Promise$Defer() {
    var promise = new Promise(INTERNAL);
    promise._setTrace(void 0);
    return new PromiseResolver(promise);
};

Promise.bind = function Promise$Bind(thisArg) {
    var maybePromise = cast(thisArg, void 0);
    var ret = new Promise(INTERNAL);
    ret._setTrace(void 0);

    if (maybePromise instanceof Promise) {
        var p = maybePromise.then(function(thisArg) {
            ret._setBoundTo(thisArg);
        });
        ret._follow(p);
    } else {
        ret._setBoundTo(thisArg);
        ret._setFulfilled();
    }
    return ret;
};

Promise.cast = function Promise$_Cast(obj) {
    var ret = cast(obj, void 0);
    if (!(ret instanceof Promise)) {
        var val = ret;
        ret = new Promise(INTERNAL);
        ret._setTrace(void 0);
        ret._setFulfilled();
        ret._cleanValues();
        ret._settledValue = val;
    }
    return ret;
};

Promise.resolve = Promise.fulfilled = Promise.cast;

Promise.reject = Promise.rejected = function Promise$Reject(reason) {
    var ret = new Promise(INTERNAL);
    ret._setTrace(void 0);
    markAsOriginatingFromRejection(reason);
    ret._cleanValues();
    ret._setRejected();
    ret._settledValue = reason;
    if (!canAttach(reason)) {
        var trace = new Error(reason + "");
        ret._setCarriedStackTrace(trace);
    }
    ret._ensurePossibleRejectionHandled();
    return ret;
};

Promise.onPossiblyUnhandledRejection =
function Promise$OnPossiblyUnhandledRejection(fn) {
        CapturedTrace.possiblyUnhandledRejection = typeof fn === "function"
                                                    ? fn : void 0;
};

var unhandledRejectionHandled;
Promise.onUnhandledRejectionHandled =
function Promise$onUnhandledRejectionHandled(fn) {
    unhandledRejectionHandled = typeof fn === "function" ? fn : void 0;
};

var debugging = false || !!(
    typeof process !== "undefined" &&
    typeof process.execPath === "string" &&
    typeof process.env === "object" &&
    (process.env["BLUEBIRD_DEBUG"] ||
        process.env["NODE_ENV"] === "development")
);


Promise.longStackTraces = function Promise$LongStackTraces() {
    if (async.haveItemsQueued() &&
        debugging === false
   ) {
        throw new Error("cannot enable long stack traces after promises have been created");
    }
    debugging = CapturedTrace.isSupported();
};

Promise.hasLongStackTraces = function Promise$HasLongStackTraces() {
    return debugging && CapturedTrace.isSupported();
};

Promise.prototype._then =
function Promise$_then(
    didFulfill,
    didReject,
    didProgress,
    receiver,
    internalData
) {
    var haveInternalData = internalData !== void 0;
    var ret = haveInternalData ? internalData : new Promise(INTERNAL);

    if (!haveInternalData) {
        if (debugging) {
            var haveSameContext = this._peekContext() === this._traceParent;
            ret._traceParent = haveSameContext ? this._traceParent : this;
        }
        ret._propagateFrom(this, 7);
    }

    var callbackIndex =
        this._addCallbacks(didFulfill, didReject, didProgress, ret, receiver);

    if (this.isResolved()) {
        async.invoke(this._queueSettleAt, this, callbackIndex);
    }

    return ret;
};

Promise.prototype._length = function Promise$_length() {
    return this._bitField & 262143;
};

Promise.prototype._isFollowingOrFulfilledOrRejected =
function Promise$_isFollowingOrFulfilledOrRejected() {
    return (this._bitField & 939524096) > 0;
};

Promise.prototype._isFollowing = function Promise$_isFollowing() {
    return (this._bitField & 536870912) === 536870912;
};

Promise.prototype._setLength = function Promise$_setLength(len) {
    this._bitField = (this._bitField & -262144) |
        (len & 262143);
};

Promise.prototype._setFulfilled = function Promise$_setFulfilled() {
    this._bitField = this._bitField | 268435456;
};

Promise.prototype._setRejected = function Promise$_setRejected() {
    this._bitField = this._bitField | 134217728;
};

Promise.prototype._setFollowing = function Promise$_setFollowing() {
    this._bitField = this._bitField | 536870912;
};

Promise.prototype._setIsFinal = function Promise$_setIsFinal() {
    this._bitField = this._bitField | 33554432;
};

Promise.prototype._isFinal = function Promise$_isFinal() {
    return (this._bitField & 33554432) > 0;
};

Promise.prototype._cancellable = function Promise$_cancellable() {
    return (this._bitField & 67108864) > 0;
};

Promise.prototype._setCancellable = function Promise$_setCancellable() {
    this._bitField = this._bitField | 67108864;
};

Promise.prototype._unsetCancellable = function Promise$_unsetCancellable() {
    this._bitField = this._bitField & (~67108864);
};

Promise.prototype._setRejectionIsUnhandled =
function Promise$_setRejectionIsUnhandled() {
    this._bitField = this._bitField | 2097152;
};

Promise.prototype._unsetRejectionIsUnhandled =
function Promise$_unsetRejectionIsUnhandled() {
    this._bitField = this._bitField & (~2097152);
    if (this._isUnhandledRejectionNotified()) {
        this._unsetUnhandledRejectionIsNotified();
        this._notifyUnhandledRejectionIsHandled();
    }
};

Promise.prototype._isRejectionUnhandled =
function Promise$_isRejectionUnhandled() {
    return (this._bitField & 2097152) > 0;
};

Promise.prototype._setUnhandledRejectionIsNotified =
function Promise$_setUnhandledRejectionIsNotified() {
    this._bitField = this._bitField | 524288;
};

Promise.prototype._unsetUnhandledRejectionIsNotified =
function Promise$_unsetUnhandledRejectionIsNotified() {
    this._bitField = this._bitField & (~524288);
};

Promise.prototype._isUnhandledRejectionNotified =
function Promise$_isUnhandledRejectionNotified() {
    return (this._bitField & 524288) > 0;
};

Promise.prototype._setCarriedStackTrace =
function Promise$_setCarriedStackTrace(capturedTrace) {
    this._bitField = this._bitField | 1048576;
    this._fulfillmentHandler0 = capturedTrace;
};

Promise.prototype._unsetCarriedStackTrace =
function Promise$_unsetCarriedStackTrace() {
    this._bitField = this._bitField & (~1048576);
    this._fulfillmentHandler0 = void 0;
};

Promise.prototype._isCarryingStackTrace =
function Promise$_isCarryingStackTrace() {
    return (this._bitField & 1048576) > 0;
};

Promise.prototype._getCarriedStackTrace =
function Promise$_getCarriedStackTrace() {
    return this._isCarryingStackTrace()
        ? this._fulfillmentHandler0
        : void 0;
};

Promise.prototype._receiverAt = function Promise$_receiverAt(index) {
    var ret = index === 0
        ? this._receiver0
        : this[(index << 2) + index - 5 + 4];
    if (this._isBound() && ret === void 0) {
        return this._boundTo;
    }
    return ret;
};

Promise.prototype._promiseAt = function Promise$_promiseAt(index) {
    return index === 0
        ? this._promise0
        : this[(index << 2) + index - 5 + 3];
};

Promise.prototype._fulfillmentHandlerAt =
function Promise$_fulfillmentHandlerAt(index) {
    return index === 0
        ? this._fulfillmentHandler0
        : this[(index << 2) + index - 5 + 0];
};

Promise.prototype._rejectionHandlerAt =
function Promise$_rejectionHandlerAt(index) {
    return index === 0
        ? this._rejectionHandler0
        : this[(index << 2) + index - 5 + 1];
};

Promise.prototype._addCallbacks = function Promise$_addCallbacks(
    fulfill,
    reject,
    progress,
    promise,
    receiver
) {
    var index = this._length();

    if (index >= 262143 - 5) {
        index = 0;
        this._setLength(0);
    }

    if (index === 0) {
        this._promise0 = promise;
        if (receiver !== void 0) this._receiver0 = receiver;
        if (typeof fulfill === "function" && !this._isCarryingStackTrace())
            this._fulfillmentHandler0 = fulfill;
        if (typeof reject === "function") this._rejectionHandler0 = reject;
        if (typeof progress === "function") this._progressHandler0 = progress;
    } else {
        var base = (index << 2) + index - 5;
        this[base + 3] = promise;
        this[base + 4] = receiver;
        this[base + 0] = typeof fulfill === "function"
                                            ? fulfill : void 0;
        this[base + 1] = typeof reject === "function"
                                            ? reject : void 0;
        this[base + 2] = typeof progress === "function"
                                            ? progress : void 0;
    }
    this._setLength(index + 1);
    return index;
};

Promise.prototype._setProxyHandlers =
function Promise$_setProxyHandlers(receiver, promiseSlotValue) {
    var index = this._length();

    if (index >= 262143 - 5) {
        index = 0;
        this._setLength(0);
    }
    if (index === 0) {
        this._promise0 = promiseSlotValue;
        this._receiver0 = receiver;
    } else {
        var base = (index << 2) + index - 5;
        this[base + 3] = promiseSlotValue;
        this[base + 4] = receiver;
        this[base + 0] =
        this[base + 1] =
        this[base + 2] = void 0;
    }
    this._setLength(index + 1);
};

Promise.prototype._proxyPromiseArray =
function Promise$_proxyPromiseArray(promiseArray, index) {
    this._setProxyHandlers(promiseArray, index);
};

Promise.prototype._proxyPromise = function Promise$_proxyPromise(promise) {
    promise._setProxied();
    this._setProxyHandlers(promise, -15);
};

Promise.prototype._setBoundTo = function Promise$_setBoundTo(obj) {
    if (obj !== void 0) {
        this._bitField = this._bitField | 8388608;
        this._boundTo = obj;
    } else {
        this._bitField = this._bitField & (~8388608);
    }
};

Promise.prototype._isBound = function Promise$_isBound() {
    return (this._bitField & 8388608) === 8388608;
};

Promise.prototype._resolveFromResolver =
function Promise$_resolveFromResolver(resolver) {
    var promise = this;
    this._setTrace(void 0);
    this._pushContext();

    function Promise$_resolver(val) {
        if (promise._tryFollow(val)) {
            return;
        }
        promise._fulfill(val);
    }
    function Promise$_rejecter(val) {
        var trace = canAttach(val) ? val : new Error(val + "");
        promise._attachExtraTrace(trace);
        markAsOriginatingFromRejection(val);
        promise._reject(val, trace === val ? void 0 : trace);
    }
    var r = tryCatch2(resolver, void 0, Promise$_resolver, Promise$_rejecter);
    this._popContext();

    if (r !== void 0 && r === errorObj) {
        var e = r.e;
        var trace = canAttach(e) ? e : new Error(e + "");
        promise._reject(e, trace);
    }
};

Promise.prototype._spreadSlowCase =
function Promise$_spreadSlowCase(targetFn, promise, values, boundTo) {
    var promiseForAll = new PromiseArray(values).promise();
    var promise2 = promiseForAll._then(function() {
        return targetFn.apply(boundTo, arguments);
    }, void 0, void 0, APPLY, void 0);
    promise._follow(promise2);
};

Promise.prototype._callSpread =
function Promise$_callSpread(handler, promise, value) {
    var boundTo = this._boundTo;
    if (isArray(value)) {
        for (var i = 0, len = value.length; i < len; ++i) {
            if (cast(value[i], void 0) instanceof Promise) {
                this._spreadSlowCase(handler, promise, value, boundTo);
                return;
            }
        }
    }
    promise._pushContext();
    return tryCatchApply(handler, value, boundTo);
};

Promise.prototype._callHandler =
function Promise$_callHandler(
    handler, receiver, promise, value) {
    var x;
    if (receiver === APPLY && !this.isRejected()) {
        x = this._callSpread(handler, promise, value);
    } else {
        promise._pushContext();
        x = tryCatch1(handler, receiver, value);
    }
    promise._popContext();
    return x;
};

Promise.prototype._settlePromiseFromHandler =
function Promise$_settlePromiseFromHandler(
    handler, receiver, value, promise
) {
    if (!(promise instanceof Promise)) {
        handler.call(receiver, value, promise);
        return;
    }
    if (promise.isResolved()) return;
    var x = this._callHandler(handler, receiver, promise, value);
    if (promise._isFollowing()) return;

    if (x === errorObj || x === promise || x === NEXT_FILTER) {
        var err = x === promise
                    ? makeSelfResolutionError()
                    : x.e;
        var trace = canAttach(err) ? err : new Error(err + "");
        if (x !== NEXT_FILTER) promise._attachExtraTrace(trace);
        promise._rejectUnchecked(err, trace);
    } else {
        var castValue = cast(x, promise);
        if (castValue instanceof Promise) {
            if (castValue.isRejected() &&
                !castValue._isCarryingStackTrace() &&
                !canAttach(castValue._settledValue)) {
                var trace = new Error(castValue._settledValue + "");
                promise._attachExtraTrace(trace);
                castValue._setCarriedStackTrace(trace);
            }
            promise._follow(castValue);
            promise._propagateFrom(castValue, 1);
        } else {
            promise._fulfillUnchecked(x);
        }
    }
};

Promise.prototype._follow =
function Promise$_follow(promise) {
    this._setFollowing();

    if (promise.isPending()) {
        this._propagateFrom(promise, 1);
        promise._proxyPromise(this);
    } else if (promise.isFulfilled()) {
        this._fulfillUnchecked(promise._settledValue);
    } else {
        this._rejectUnchecked(promise._settledValue,
            promise._getCarriedStackTrace());
    }

    if (promise._isRejectionUnhandled()) promise._unsetRejectionIsUnhandled();

    if (debugging &&
        promise._traceParent == null) {
        promise._traceParent = this;
    }
};

Promise.prototype._tryFollow =
function Promise$_tryFollow(value) {
    if (this._isFollowingOrFulfilledOrRejected() ||
        value === this) {
        return false;
    }
    var maybePromise = cast(value, void 0);
    if (!(maybePromise instanceof Promise)) {
        return false;
    }
    this._follow(maybePromise);
    return true;
};

Promise.prototype._resetTrace = function Promise$_resetTrace() {
    if (debugging) {
        this._trace = new CapturedTrace(this._peekContext() === void 0);
    }
};

Promise.prototype._setTrace = function Promise$_setTrace(parent) {
    if (debugging) {
        var context = this._peekContext();
        this._traceParent = context;
        var isTopLevel = context === void 0;
        if (parent !== void 0 &&
            parent._traceParent === context) {
            this._trace = parent._trace;
        } else {
            this._trace = new CapturedTrace(isTopLevel);
        }
    }
    return this;
};

Promise.prototype._tryAttachExtraTrace =
function Promise$_tryAttachExtraTrace(error) {
    if (canAttach(error)) {
        this._attachExtraTrace(error);
    }
};

Promise.prototype._attachExtraTrace =
function Promise$_attachExtraTrace(error) {
    if (debugging) {
        var promise = this;
        var stack = error.stack;
        stack = typeof stack === "string" ? stack.split("\n") : [];
        CapturedTrace.protectErrorMessageNewlines(stack);
        var headerLineCount = 1;
        var combinedTraces = 1;
        while(promise != null &&
            promise._trace != null) {
            stack = CapturedTrace.combine(
                stack,
                promise._trace.stack.split("\n")
            );
            promise = promise._traceParent;
            combinedTraces++;
        }

        var stackTraceLimit = Error.stackTraceLimit || 10;
        var max = (stackTraceLimit + headerLineCount) * combinedTraces;
        var len = stack.length;
        if (len > max) {
            stack.length = max;
        }

        if (len > 0)
            stack[0] = stack[0].split("\u0002\u0000\u0001").join("\n");

        if (stack.length <= headerLineCount) {
            error.stack = "(No stack trace)";
        } else {
            error.stack = stack.join("\n");
        }
    }
};

Promise.prototype._cleanValues = function Promise$_cleanValues() {
    if (this._cancellable()) {
        this._cancellationParent = void 0;
    }
};

Promise.prototype._propagateFrom =
function Promise$_propagateFrom(parent, flags) {
    if ((flags & 1) > 0 && parent._cancellable()) {
        this._setCancellable();
        this._cancellationParent = parent;
    }
    if ((flags & 4) > 0) {
        this._setBoundTo(parent._boundTo);
    }
    if ((flags & 2) > 0) {
        this._setTrace(parent);
    }
};

Promise.prototype._fulfill = function Promise$_fulfill(value) {
    if (this._isFollowingOrFulfilledOrRejected()) return;
    this._fulfillUnchecked(value);
};

Promise.prototype._reject =
function Promise$_reject(reason, carriedStackTrace) {
    if (this._isFollowingOrFulfilledOrRejected()) return;
    this._rejectUnchecked(reason, carriedStackTrace);
};

Promise.prototype._settlePromiseAt = function Promise$_settlePromiseAt(index) {
    var handler = this.isFulfilled()
        ? this._fulfillmentHandlerAt(index)
        : this._rejectionHandlerAt(index);

    var value = this._settledValue;
    var receiver = this._receiverAt(index);
    var promise = this._promiseAt(index);

    if (typeof handler === "function") {
        this._settlePromiseFromHandler(handler, receiver, value, promise);
    } else {
        var done = false;
        var isFulfilled = this.isFulfilled();
        if (receiver !== void 0) {
            if (receiver instanceof Promise &&
                receiver._isProxied()) {
                receiver._unsetProxied();

                if (isFulfilled) receiver._fulfillUnchecked(value);
                else receiver._rejectUnchecked(value,
                    this._getCarriedStackTrace());
                done = true;
            } else if (receiver instanceof PromiseArray) {
                if (isFulfilled) receiver._promiseFulfilled(value, promise);
                else receiver._promiseRejected(value, promise);
                done = true;
            }
        }

        if (!done) {
            if (isFulfilled) promise._fulfill(value);
            else promise._reject(value, this._getCarriedStackTrace());
        }
    }

    if (index >= 4) {
        this._queueGC();
    }
};

Promise.prototype._isProxied = function Promise$_isProxied() {
    return (this._bitField & 4194304) === 4194304;
};

Promise.prototype._setProxied = function Promise$_setProxied() {
    this._bitField = this._bitField | 4194304;
};

Promise.prototype._unsetProxied = function Promise$_unsetProxied() {
    this._bitField = this._bitField & (~4194304);
};

Promise.prototype._isGcQueued = function Promise$_isGcQueued() {
    return (this._bitField & -1073741824) === -1073741824;
};

Promise.prototype._setGcQueued = function Promise$_setGcQueued() {
    this._bitField = this._bitField | -1073741824;
};

Promise.prototype._unsetGcQueued = function Promise$_unsetGcQueued() {
    this._bitField = this._bitField & (~-1073741824);
};

Promise.prototype._queueGC = function Promise$_queueGC() {
    if (this._isGcQueued()) return;
    this._setGcQueued();
    async.invokeLater(this._gc, this, void 0);
};

Promise.prototype._gc = function Promise$gc() {
    var len = this._length() * 5 - 5;
    for (var i = 0; i < len; i++) {
        delete this[i];
    }
    this._clearFirstHandlerData();
    this._setLength(0);
    this._unsetGcQueued();
};

Promise.prototype._clearFirstHandlerData =
function Promise$_clearFirstHandlerData() {
    this._fulfillmentHandler0 = void 0;
    this._rejectionHandler0 = void 0;
    this._promise0 = void 0;
    this._receiver0 = void 0;
};

Promise.prototype._queueSettleAt = function Promise$_queueSettleAt(index) {
    if (this._isRejectionUnhandled()) this._unsetRejectionIsUnhandled();
    async.invoke(this._settlePromiseAt, this, index);
};

Promise.prototype._fulfillUnchecked =
function Promise$_fulfillUnchecked(value) {
    if (!this.isPending()) return;
    if (value === this) {
        var err = makeSelfResolutionError();
        this._attachExtraTrace(err);
        return this._rejectUnchecked(err, void 0);
    }
    this._cleanValues();
    this._setFulfilled();
    this._settledValue = value;
    var len = this._length();

    if (len > 0) {
        async.invoke(this._settlePromises, this, len);
    }
};

Promise.prototype._rejectUncheckedCheckError =
function Promise$_rejectUncheckedCheckError(reason) {
    var trace = canAttach(reason) ? reason : new Error(reason + "");
    this._rejectUnchecked(reason, trace === reason ? void 0 : trace);
};

Promise.prototype._rejectUnchecked =
function Promise$_rejectUnchecked(reason, trace) {
    if (!this.isPending()) return;
    if (reason === this) {
        var err = makeSelfResolutionError();
        this._attachExtraTrace(err);
        return this._rejectUnchecked(err);
    }
    this._cleanValues();
    this._setRejected();
    this._settledValue = reason;

    if (this._isFinal()) {
        async.invokeLater(thrower, void 0, trace === void 0 ? reason : trace);
        return;
    }
    var len = this._length();

    if (trace !== void 0) this._setCarriedStackTrace(trace);

    if (len > 0) {
        async.invoke(this._rejectPromises, this, null);
    } else {
        this._ensurePossibleRejectionHandled();
    }
};

Promise.prototype._rejectPromises = function Promise$_rejectPromises() {
    this._settlePromises();
    this._unsetCarriedStackTrace();
};

Promise.prototype._settlePromises = function Promise$_settlePromises() {
    var len = this._length();
    for (var i = 0; i < len; i++) {
        this._settlePromiseAt(i);
    }
};

Promise.prototype._ensurePossibleRejectionHandled =
function Promise$_ensurePossibleRejectionHandled() {
    this._setRejectionIsUnhandled();
    if (CapturedTrace.possiblyUnhandledRejection !== void 0) {
        async.invokeLater(this._notifyUnhandledRejection, this, void 0);
    }
};

Promise.prototype._notifyUnhandledRejectionIsHandled =
function Promise$_notifyUnhandledRejectionIsHandled() {
    if (typeof unhandledRejectionHandled === "function") {
        async.invokeLater(unhandledRejectionHandled, void 0, this);
    }
};

Promise.prototype._notifyUnhandledRejection =
function Promise$_notifyUnhandledRejection() {
    if (this._isRejectionUnhandled()) {
        var reason = this._settledValue;
        var trace = this._getCarriedStackTrace();

        this._setUnhandledRejectionIsNotified();

        if (trace !== void 0) {
            this._unsetCarriedStackTrace();
            reason = trace;
        }
        if (typeof CapturedTrace.possiblyUnhandledRejection === "function") {
            CapturedTrace.possiblyUnhandledRejection(reason, this);
        }
    }
};

var contextStack = [];
Promise.prototype._peekContext = function Promise$_peekContext() {
    var lastIndex = contextStack.length - 1;
    if (lastIndex >= 0) {
        return contextStack[lastIndex];
    }
    return void 0;

};

Promise.prototype._pushContext = function Promise$_pushContext() {
    if (!debugging) return;
    contextStack.push(this);
};

Promise.prototype._popContext = function Promise$_popContext() {
    if (!debugging) return;
    contextStack.pop();
};

Promise.noConflict = function Promise$NoConflict() {
    return noConflict(Promise);
};

Promise.setScheduler = function(fn) {
    if (typeof fn !== "function") throw new TypeError("fn must be a function");
    async._schedule = fn;
};

if (!CapturedTrace.isSupported()) {
    Promise.longStackTraces = function(){};
    debugging = false;
}

Promise._makeSelfResolutionError = makeSelfResolutionError;
require("./finally.js")(Promise, NEXT_FILTER, cast);
require("./direct_resolve.js")(Promise);
require("./synchronous_inspection.js")(Promise);
require("./join.js")(Promise, PromiseArray, cast, INTERNAL);
Promise.RangeError = RangeError;
Promise.CancellationError = CancellationError;
Promise.TimeoutError = TimeoutError;
Promise.TypeError = TypeError;
Promise.OperationalError = OperationalError;
Promise.RejectionError = OperationalError;
Promise.AggregateError = errors.AggregateError;

util.toFastProperties(Promise);
util.toFastProperties(Promise.prototype);
Promise.Promise = Promise;
require('./timers.js')(Promise,INTERNAL,cast);
require('./race.js')(Promise,INTERNAL,cast);
require('./call_get.js')(Promise);
require('./generators.js')(Promise,apiRejection,INTERNAL,cast);
require('./map.js')(Promise,PromiseArray,apiRejection,cast,INTERNAL);
require('./nodeify.js')(Promise);
require('./promisify.js')(Promise,INTERNAL);
require('./props.js')(Promise,PromiseArray,cast);
require('./reduce.js')(Promise,PromiseArray,apiRejection,cast,INTERNAL);
require('./settle.js')(Promise,PromiseArray);
require('./some.js')(Promise,PromiseArray,apiRejection);
require('./progress.js')(Promise,PromiseArray);
require('./cancel.js')(Promise,INTERNAL);
require('./filter.js')(Promise,INTERNAL);
require('./any.js')(Promise,PromiseArray);
require('./each.js')(Promise,INTERNAL);
require('./using.js')(Promise,apiRejection,cast);

Promise.prototype = Promise.prototype;
return Promise;

};

}).call(this,require('_process'))

},{"./any.js":6,"./async.js":7,"./call_get.js":9,"./cancel.js":10,"./captured_trace.js":11,"./catch_filter.js":12,"./direct_resolve.js":13,"./each.js":14,"./errors.js":15,"./errors_api_rejection":16,"./filter.js":18,"./finally.js":19,"./generators.js":20,"./join.js":21,"./map.js":22,"./nodeify.js":23,"./progress.js":24,"./promise_array.js":26,"./promise_resolver.js":27,"./promisify.js":28,"./props.js":29,"./race.js":31,"./reduce.js":32,"./settle.js":34,"./some.js":35,"./synchronous_inspection.js":36,"./thenables.js":37,"./timers.js":38,"./using.js":39,"./util.js":40,"_process":43}],26:[function(require,module,exports){
/**
 * The MIT License (MIT)
 * 
 * Copyright (c) 2014 Petka Antonov
 * 
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:</p>
 * 
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * 
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.  IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 * 
 */
"use strict";
module.exports = function(Promise, INTERNAL, cast) {
var canAttach = require("./errors.js").canAttach;
var util = require("./util.js");
var isArray = util.isArray;

function toResolutionValue(val) {
    switch(val) {
    case -1: return void 0;
    case -2: return [];
    case -3: return {};
    }
}

function PromiseArray(values) {
    var promise = this._promise = new Promise(INTERNAL);
    var parent = void 0;
    if (values instanceof Promise) {
        parent = values;
        promise._propagateFrom(parent, 1 | 4);
    }
    promise._setTrace(parent);
    this._values = values;
    this._length = 0;
    this._totalResolved = 0;
    this._init(void 0, -2);
}
PromiseArray.prototype.length = function PromiseArray$length() {
    return this._length;
};

PromiseArray.prototype.promise = function PromiseArray$promise() {
    return this._promise;
};

PromiseArray.prototype._init =
function PromiseArray$_init(_, resolveValueIfEmpty) {
    var values = cast(this._values, void 0);
    if (values instanceof Promise) {
        this._values = values;
        values._setBoundTo(this._promise._boundTo);
        if (values.isFulfilled()) {
            values = values._settledValue;
            if (!isArray(values)) {
                var err = new Promise.TypeError("expecting an array, a promise or a thenable");
                this.__hardReject__(err);
                return;
            }
        } else if (values.isPending()) {
            values._then(
                PromiseArray$_init,
                this._reject,
                void 0,
                this,
                resolveValueIfEmpty
           );
            return;
        } else {
            values._unsetRejectionIsUnhandled();
            this._reject(values._settledValue);
            return;
        }
    } else if (!isArray(values)) {
        var err = new Promise.TypeError("expecting an array, a promise or a thenable");
        this.__hardReject__(err);
        return;
    }

    if (values.length === 0) {
        if (resolveValueIfEmpty === -5) {
            this._resolveEmptyArray();
        }
        else {
            this._resolve(toResolutionValue(resolveValueIfEmpty));
        }
        return;
    }
    var len = this.getActualLength(values.length);
    var newLen = len;
    var newValues = this.shouldCopyValues() ? new Array(len) : this._values;
    var isDirectScanNeeded = false;
    for (var i = 0; i < len; ++i) {
        var maybePromise = cast(values[i], void 0);
        if (maybePromise instanceof Promise) {
            if (maybePromise.isPending()) {
                maybePromise._proxyPromiseArray(this, i);
            } else {
                maybePromise._unsetRejectionIsUnhandled();
                isDirectScanNeeded = true;
            }
        } else {
            isDirectScanNeeded = true;
        }
        newValues[i] = maybePromise;
    }
    this._values = newValues;
    this._length = newLen;
    if (isDirectScanNeeded) {
        this._scanDirectValues(len);
    }
};

PromiseArray.prototype._settlePromiseAt =
function PromiseArray$_settlePromiseAt(index) {
    var value = this._values[index];
    if (!(value instanceof Promise)) {
        this._promiseFulfilled(value, index);
    } else if (value.isFulfilled()) {
        this._promiseFulfilled(value._settledValue, index);
    } else if (value.isRejected()) {
        this._promiseRejected(value._settledValue, index);
    }
};

PromiseArray.prototype._scanDirectValues =
function PromiseArray$_scanDirectValues(len) {
    for (var i = 0; i < len; ++i) {
        if (this._isResolved()) {
            break;
        }
        this._settlePromiseAt(i);
    }
};

PromiseArray.prototype._isResolved = function PromiseArray$_isResolved() {
    return this._values === null;
};

PromiseArray.prototype._resolve = function PromiseArray$_resolve(value) {
    this._values = null;
    this._promise._fulfill(value);
};

PromiseArray.prototype.__hardReject__ =
PromiseArray.prototype._reject = function PromiseArray$_reject(reason) {
    this._values = null;
    var trace = canAttach(reason) ? reason : new Error(reason + "");
    this._promise._attachExtraTrace(trace);
    this._promise._reject(reason, trace);
};

PromiseArray.prototype._promiseProgressed =
function PromiseArray$_promiseProgressed(progressValue, index) {
    if (this._isResolved()) return;
    this._promise._progress({
        index: index,
        value: progressValue
    });
};


PromiseArray.prototype._promiseFulfilled =
function PromiseArray$_promiseFulfilled(value, index) {
    if (this._isResolved()) return;
    this._values[index] = value;
    var totalResolved = ++this._totalResolved;
    if (totalResolved >= this._length) {
        this._resolve(this._values);
    }
};

PromiseArray.prototype._promiseRejected =
function PromiseArray$_promiseRejected(reason, index) {
    if (this._isResolved()) return;
    this._totalResolved++;
    this._reject(reason);
};

PromiseArray.prototype.shouldCopyValues =
function PromiseArray$_shouldCopyValues() {
    return true;
};

PromiseArray.prototype.getActualLength =
function PromiseArray$getActualLength(len) {
    return len;
};

return PromiseArray;
};

},{"./errors.js":15,"./util.js":40}],27:[function(require,module,exports){
/**
 * The MIT License (MIT)
 * 
 * Copyright (c) 2014 Petka Antonov
 * 
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:</p>
 * 
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * 
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.  IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 * 
 */
"use strict";
var util = require("./util.js");
var maybeWrapAsError = util.maybeWrapAsError;
var errors = require("./errors.js");
var TimeoutError = errors.TimeoutError;
var OperationalError = errors.OperationalError;
var async = require("./async.js");
var haveGetters = util.haveGetters;
var es5 = require("./es5.js");

function isUntypedError(obj) {
    return obj instanceof Error &&
        es5.getPrototypeOf(obj) === Error.prototype;
}

function wrapAsOperationalError(obj) {
    var ret;
    if (isUntypedError(obj)) {
        ret = new OperationalError(obj);
    } else {
        ret = obj;
    }
    errors.markAsOriginatingFromRejection(ret);
    return ret;
}

function nodebackForPromise(promise) {
    function PromiseResolver$_callback(err, value) {
        if (promise === null) return;

        if (err) {
            var wrapped = wrapAsOperationalError(maybeWrapAsError(err));
            promise._attachExtraTrace(wrapped);
            promise._reject(wrapped);
        } else if (arguments.length > 2) {
            var $_len = arguments.length;var args = new Array($_len - 1); for(var $_i = 1; $_i < $_len; ++$_i) {args[$_i - 1] = arguments[$_i];}
            promise._fulfill(args);
        } else {
            promise._fulfill(value);
        }

        promise = null;
    }
    return PromiseResolver$_callback;
}


var PromiseResolver;
if (!haveGetters) {
    PromiseResolver = function PromiseResolver(promise) {
        this.promise = promise;
        this.asCallback = nodebackForPromise(promise);
        this.callback = this.asCallback;
    };
}
else {
    PromiseResolver = function PromiseResolver(promise) {
        this.promise = promise;
    };
}
if (haveGetters) {
    var prop = {
        get: function() {
            return nodebackForPromise(this.promise);
        }
    };
    es5.defineProperty(PromiseResolver.prototype, "asCallback", prop);
    es5.defineProperty(PromiseResolver.prototype, "callback", prop);
}

PromiseResolver._nodebackForPromise = nodebackForPromise;

PromiseResolver.prototype.toString = function PromiseResolver$toString() {
    return "[object PromiseResolver]";
};

PromiseResolver.prototype.resolve =
PromiseResolver.prototype.fulfill = function PromiseResolver$resolve(value) {
    if (!(this instanceof PromiseResolver)) {
        throw new TypeError("Illegal invocation, resolver resolve/reject must be called within a resolver context. Consider using the promise constructor instead.");
    }

    var promise = this.promise;
    if (promise._tryFollow(value)) {
        return;
    }
    async.invoke(promise._fulfill, promise, value);
};

PromiseResolver.prototype.reject = function PromiseResolver$reject(reason) {
    if (!(this instanceof PromiseResolver)) {
        throw new TypeError("Illegal invocation, resolver resolve/reject must be called within a resolver context. Consider using the promise constructor instead.");
    }

    var promise = this.promise;
    errors.markAsOriginatingFromRejection(reason);
    var trace = errors.canAttach(reason) ? reason : new Error(reason + "");
    promise._attachExtraTrace(trace);
    async.invoke(promise._reject, promise, reason);
    if (trace !== reason) {
        async.invoke(this._setCarriedStackTrace, this, trace);
    }
};

PromiseResolver.prototype.progress =
function PromiseResolver$progress(value) {
    if (!(this instanceof PromiseResolver)) {
        throw new TypeError("Illegal invocation, resolver resolve/reject must be called within a resolver context. Consider using the promise constructor instead.");
    }
    async.invoke(this.promise._progress, this.promise, value);
};

PromiseResolver.prototype.cancel = function PromiseResolver$cancel() {
    async.invoke(this.promise.cancel, this.promise, void 0);
};

PromiseResolver.prototype.timeout = function PromiseResolver$timeout() {
    this.reject(new TimeoutError("timeout"));
};

PromiseResolver.prototype.isResolved = function PromiseResolver$isResolved() {
    return this.promise.isResolved();
};

PromiseResolver.prototype.toJSON = function PromiseResolver$toJSON() {
    return this.promise.toJSON();
};

PromiseResolver.prototype._setCarriedStackTrace =
function PromiseResolver$_setCarriedStackTrace(trace) {
    if (this.promise.isRejected()) {
        this.promise._setCarriedStackTrace(trace);
    }
};

module.exports = PromiseResolver;

},{"./async.js":7,"./errors.js":15,"./es5.js":17,"./util.js":40}],28:[function(require,module,exports){
/**
 * The MIT License (MIT)
 * 
 * Copyright (c) 2014 Petka Antonov
 * 
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:</p>
 * 
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * 
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.  IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 * 
 */
"use strict";
module.exports = function(Promise, INTERNAL) {
var THIS = {};
var util = require("./util.js");
var nodebackForPromise = require("./promise_resolver.js")
    ._nodebackForPromise;
var withAppended = util.withAppended;
var maybeWrapAsError = util.maybeWrapAsError;
var canEvaluate = util.canEvaluate;
var TypeError = require("./errors").TypeError;
var defaultSuffix = "Async";
var defaultFilter = function(name, func) {
    return util.isIdentifier(name) &&
        name.charAt(0) !== "_" &&
        !util.isClass(func);
};
var defaultPromisified = {__isPromisified__: true};


function escapeIdentRegex(str) {
    return str.replace(/([$])/, "\\$");
}

function isPromisified(fn) {
    try {
        return fn.__isPromisified__ === true;
    }
    catch (e) {
        return false;
    }
}

function hasPromisified(obj, key, suffix) {
    var val = util.getDataPropertyOrDefault(obj, key + suffix,
                                            defaultPromisified);
    return val ? isPromisified(val) : false;
}
function checkValid(ret, suffix, suffixRegexp) {
    for (var i = 0; i < ret.length; i += 2) {
        var key = ret[i];
        if (suffixRegexp.test(key)) {
            var keyWithoutAsyncSuffix = key.replace(suffixRegexp, "");
            for (var j = 0; j < ret.length; j += 2) {
                if (ret[j] === keyWithoutAsyncSuffix) {
                    throw new TypeError("Cannot promisify an API " +
                        "that has normal methods with '"+suffix+"'-suffix");
                }
            }
        }
    }
}

function promisifiableMethods(obj, suffix, suffixRegexp, filter) {
    var keys = util.inheritedDataKeys(obj);
    var ret = [];
    for (var i = 0; i < keys.length; ++i) {
        var key = keys[i];
        var value = obj[key];
        if (typeof value === "function" &&
            !isPromisified(value) &&
            !hasPromisified(obj, key, suffix) &&
            filter(key, value, obj)) {
            ret.push(key, value);
        }
    }
    checkValid(ret, suffix, suffixRegexp);
    return ret;
}

function switchCaseArgumentOrder(likelyArgumentCount) {
    var ret = [likelyArgumentCount];
    var min = Math.max(0, likelyArgumentCount - 1 - 5);
    for(var i = likelyArgumentCount - 1; i >= min; --i) {
        if (i === likelyArgumentCount) continue;
        ret.push(i);
    }
    for(var i = likelyArgumentCount + 1; i <= 5; ++i) {
        ret.push(i);
    }
    return ret;
}

function argumentSequence(argumentCount) {
    return util.filledRange(argumentCount, "arguments[", "]");
}

function parameterDeclaration(parameterCount) {
    return util.filledRange(parameterCount, "_arg", "");
}

function parameterCount(fn) {
    if (typeof fn.length === "number") {
        return Math.max(Math.min(fn.length, 1023 + 1), 0);
    }
    return 0;
}

function generatePropertyAccess(key) {
    if (util.isIdentifier(key)) {
        return "." + key;
    }
    else return "['" + key.replace(/(['\\])/g, "\\$1") + "']";
}

function makeNodePromisifiedEval(callback, receiver, originalName, fn, suffix) {
    var newParameterCount = Math.max(0, parameterCount(fn) - 1);
    var argumentOrder = switchCaseArgumentOrder(newParameterCount);
    var callbackName =
        (typeof originalName === "string" && util.isIdentifier(originalName)
            ? originalName + suffix
            : "promisified");

    function generateCallForArgumentCount(count) {
        var args = argumentSequence(count).join(", ");
        var comma = count > 0 ? ", " : "";
        var ret;
        if (typeof callback === "string") {
            ret = "                                                          \n\
                this.method({{args}}, fn);                                   \n\
                break;                                                       \n\
            ".replace(".method", generatePropertyAccess(callback));
        } else if (receiver === THIS) {
            ret =  "                                                         \n\
                callback.call(this, {{args}}, fn);                           \n\
                break;                                                       \n\
            ";
        } else if (receiver !== void 0) {
            ret =  "                                                         \n\
                callback.call(receiver, {{args}}, fn);                       \n\
                break;                                                       \n\
            ";
        } else {
            ret =  "                                                         \n\
                callback({{args}}, fn);                                      \n\
                break;                                                       \n\
            ";
        }
        return ret.replace("{{args}}", args).replace(", ", comma);
    }

    function generateArgumentSwitchCase() {
        var ret = "";
        for(var i = 0; i < argumentOrder.length; ++i) {
            ret += "case " + argumentOrder[i] +":" +
                generateCallForArgumentCount(argumentOrder[i]);
        }
        var codeForCall;
        if (typeof callback === "string") {
            codeForCall = "                                                  \n\
                this.property.apply(this, args);                             \n\
            "
                .replace(".property", generatePropertyAccess(callback));
        } else if (receiver === THIS) {
            codeForCall = "                                                  \n\
                callback.apply(this, args);                                  \n\
            ";
        } else {
            codeForCall = "                                                  \n\
                callback.apply(receiver, args);                              \n\
            ";
        }

        ret += "                                                             \n\
        default:                                                             \n\
            var args = new Array(len + 1);                                   \n\
            var i = 0;                                                       \n\
            for (var i = 0; i < len; ++i) {                                  \n\
               args[i] = arguments[i];                                       \n\
            }                                                                \n\
            args[i] = fn;                                                    \n\
            [CodeForCall]                                                    \n\
            break;                                                           \n\
        ".replace("[CodeForCall]", codeForCall);
        return ret;
    }

    return new Function("Promise",
                        "callback",
                        "receiver",
                        "withAppended",
                        "maybeWrapAsError",
                        "nodebackForPromise",
                        "INTERNAL","                                         \n\
        var ret = function FunctionName(Parameters) {                        \n\
            'use strict';                                                    \n\
            var len = arguments.length;                                      \n\
            var promise = new Promise(INTERNAL);                             \n\
            promise._setTrace(void 0);                                       \n\
            var fn = nodebackForPromise(promise);                            \n\
            try {                                                            \n\
                switch(len) {                                                \n\
                    [CodeForSwitchCase]                                      \n\
                }                                                            \n\
            } catch (e) {                                                    \n\
                var wrapped = maybeWrapAsError(e);                           \n\
                promise._attachExtraTrace(wrapped);                          \n\
                promise._reject(wrapped);                                    \n\
            }                                                                \n\
            return promise;                                                  \n\
        };                                                                   \n\
        ret.__isPromisified__ = true;                                        \n\
        return ret;                                                          \n\
        "
        .replace("FunctionName", callbackName)
        .replace("Parameters", parameterDeclaration(newParameterCount))
        .replace("[CodeForSwitchCase]", generateArgumentSwitchCase()))(
            Promise,
            callback,
            receiver,
            withAppended,
            maybeWrapAsError,
            nodebackForPromise,
            INTERNAL
        );
}

function makeNodePromisifiedClosure(callback, receiver) {
    function promisified() {
        var _receiver = receiver;
        if (receiver === THIS) _receiver = this;
        if (typeof callback === "string") {
            callback = _receiver[callback];
        }
        var promise = new Promise(INTERNAL);
        promise._setTrace(void 0);
        var fn = nodebackForPromise(promise);
        try {
            callback.apply(_receiver, withAppended(arguments, fn));
        } catch(e) {
            var wrapped = maybeWrapAsError(e);
            promise._attachExtraTrace(wrapped);
            promise._reject(wrapped);
        }
        return promise;
    }
    promisified.__isPromisified__ = true;
    return promisified;
}

var makeNodePromisified = canEvaluate
    ? makeNodePromisifiedEval
    : makeNodePromisifiedClosure;

function promisifyAll(obj, suffix, filter, promisifier) {
    var suffixRegexp = new RegExp(escapeIdentRegex(suffix) + "$");
    var methods =
        promisifiableMethods(obj, suffix, suffixRegexp, filter);

    for (var i = 0, len = methods.length; i < len; i+= 2) {
        var key = methods[i];
        var fn = methods[i+1];
        var promisifiedKey = key + suffix;
        obj[promisifiedKey] = promisifier === makeNodePromisified
                ? makeNodePromisified(key, THIS, key, fn, suffix)
                : promisifier(fn);
    }
    util.toFastProperties(obj);
    return obj;
}

function promisify(callback, receiver) {
    return makeNodePromisified(callback, receiver, void 0, callback);
}

Promise.promisify = function Promise$Promisify(fn, receiver) {
    if (typeof fn !== "function") {
        throw new TypeError("fn must be a function");
    }
    if (isPromisified(fn)) {
        return fn;
    }
    return promisify(fn, arguments.length < 2 ? THIS : receiver);
};

Promise.promisifyAll = function Promise$PromisifyAll(target, options) {
    if (typeof target !== "function" && typeof target !== "object") {
        throw new TypeError("the target of promisifyAll must be an object or a function");
    }
    options = Object(options);
    var suffix = options.suffix;
    if (typeof suffix !== "string") suffix = defaultSuffix;
    var filter = options.filter;
    if (typeof filter !== "function") filter = defaultFilter;
    var promisifier = options.promisifier;
    if (typeof promisifier !== "function") promisifier = makeNodePromisified;

    if (!util.isIdentifier(suffix)) {
        throw new RangeError("suffix must be a valid identifier");
    }

    var keys = util.inheritedDataKeys(target, {includeHidden: true});
    for (var i = 0; i < keys.length; ++i) {
        var value = target[keys[i]];
        if (keys[i] !== "constructor" &&
            util.isClass(value)) {
            promisifyAll(value.prototype, suffix, filter, promisifier);
            promisifyAll(value, suffix, filter, promisifier);
        }
    }

    return promisifyAll(target, suffix, filter, promisifier);
};
};


},{"./errors":15,"./promise_resolver.js":27,"./util.js":40}],29:[function(require,module,exports){
/**
 * The MIT License (MIT)
 * 
 * Copyright (c) 2014 Petka Antonov
 * 
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:</p>
 * 
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * 
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.  IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 * 
 */
"use strict";
module.exports = function(Promise, PromiseArray, cast) {
var util = require("./util.js");
var apiRejection = require("./errors_api_rejection")(Promise);
var isObject = util.isObject;
var es5 = require("./es5.js");

function PropertiesPromiseArray(obj) {
    var keys = es5.keys(obj);
    var len = keys.length;
    var values = new Array(len * 2);
    for (var i = 0; i < len; ++i) {
        var key = keys[i];
        values[i] = obj[key];
        values[i + len] = key;
    }
    this.constructor$(values);
}
util.inherits(PropertiesPromiseArray, PromiseArray);

PropertiesPromiseArray.prototype._init =
function PropertiesPromiseArray$_init() {
    this._init$(void 0, -3) ;
};

PropertiesPromiseArray.prototype._promiseFulfilled =
function PropertiesPromiseArray$_promiseFulfilled(value, index) {
    if (this._isResolved()) return;
    this._values[index] = value;
    var totalResolved = ++this._totalResolved;
    if (totalResolved >= this._length) {
        var val = {};
        var keyOffset = this.length();
        for (var i = 0, len = this.length(); i < len; ++i) {
            val[this._values[i + keyOffset]] = this._values[i];
        }
        this._resolve(val);
    }
};

PropertiesPromiseArray.prototype._promiseProgressed =
function PropertiesPromiseArray$_promiseProgressed(value, index) {
    if (this._isResolved()) return;

    this._promise._progress({
        key: this._values[index + this.length()],
        value: value
    });
};

PropertiesPromiseArray.prototype.shouldCopyValues =
function PropertiesPromiseArray$_shouldCopyValues() {
    return false;
};

PropertiesPromiseArray.prototype.getActualLength =
function PropertiesPromiseArray$getActualLength(len) {
    return len >> 1;
};

function Promise$_Props(promises) {
    var ret;
    var castValue = cast(promises, void 0);

    if (!isObject(castValue)) {
        return apiRejection("cannot await properties of a non-object");
    } else if (castValue instanceof Promise) {
        ret = castValue._then(Promise.props, void 0, void 0, void 0, void 0);
    } else {
        ret = new PropertiesPromiseArray(castValue).promise();
    }

    if (castValue instanceof Promise) {
        ret._propagateFrom(castValue, 4);
    }
    return ret;
}

Promise.prototype.props = function Promise$props() {
    return Promise$_Props(this);
};

Promise.props = function Promise$Props(promises) {
    return Promise$_Props(promises);
};
};

},{"./errors_api_rejection":16,"./es5.js":17,"./util.js":40}],30:[function(require,module,exports){
/**
 * The MIT License (MIT)
 * 
 * Copyright (c) 2014 Petka Antonov
 * 
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:</p>
 * 
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * 
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.  IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 * 
 */
"use strict";
function arrayCopy(src, srcIndex, dst, dstIndex, len) {
    for (var j = 0; j < len; ++j) {
        dst[j + dstIndex] = src[j + srcIndex];
    }
}

function Queue(capacity) {
    this._capacity = capacity;
    this._length = 0;
    this._front = 0;
    this._makeCapacity();
}

Queue.prototype._willBeOverCapacity =
function Queue$_willBeOverCapacity(size) {
    return this._capacity < size;
};

Queue.prototype._pushOne = function Queue$_pushOne(arg) {
    var length = this.length();
    this._checkCapacity(length + 1);
    var i = (this._front + length) & (this._capacity - 1);
    this[i] = arg;
    this._length = length + 1;
};

Queue.prototype.push = function Queue$push(fn, receiver, arg) {
    var length = this.length() + 3;
    if (this._willBeOverCapacity(length)) {
        this._pushOne(fn);
        this._pushOne(receiver);
        this._pushOne(arg);
        return;
    }
    var j = this._front + length - 3;
    this._checkCapacity(length);
    var wrapMask = this._capacity - 1;
    this[(j + 0) & wrapMask] = fn;
    this[(j + 1) & wrapMask] = receiver;
    this[(j + 2) & wrapMask] = arg;
    this._length = length;
};

Queue.prototype.shift = function Queue$shift() {
    var front = this._front,
        ret = this[front];

    this[front] = void 0;
    this._front = (front + 1) & (this._capacity - 1);
    this._length--;
    return ret;
};

Queue.prototype.length = function Queue$length() {
    return this._length;
};

Queue.prototype._makeCapacity = function Queue$_makeCapacity() {
    var len = this._capacity;
    for (var i = 0; i < len; ++i) {
        this[i] = void 0;
    }
};

Queue.prototype._checkCapacity = function Queue$_checkCapacity(size) {
    if (this._capacity < size) {
        this._resizeTo(this._capacity << 3);
    }
};

Queue.prototype._resizeTo = function Queue$_resizeTo(capacity) {
    var oldFront = this._front;
    var oldCapacity = this._capacity;
    var oldQueue = new Array(oldCapacity);
    var length = this.length();

    arrayCopy(this, 0, oldQueue, 0, oldCapacity);
    this._capacity = capacity;
    this._makeCapacity();
    this._front = 0;
    if (oldFront + length <= oldCapacity) {
        arrayCopy(oldQueue, oldFront, this, 0, length);
    } else {        var lengthBeforeWrapping =
            length - ((oldFront + length) & (oldCapacity - 1));

        arrayCopy(oldQueue, oldFront, this, 0, lengthBeforeWrapping);
        arrayCopy(oldQueue, 0, this, lengthBeforeWrapping,
                    length - lengthBeforeWrapping);
    }
};

module.exports = Queue;

},{}],31:[function(require,module,exports){
/**
 * The MIT License (MIT)
 * 
 * Copyright (c) 2014 Petka Antonov
 * 
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:</p>
 * 
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * 
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.  IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 * 
 */
"use strict";
module.exports = function(Promise, INTERNAL, cast) {
var apiRejection = require("./errors_api_rejection.js")(Promise);
var isArray = require("./util.js").isArray;

var raceLater = function Promise$_raceLater(promise) {
    return promise.then(function(array) {
        return Promise$_Race(array, promise);
    });
};

var hasOwn = {}.hasOwnProperty;
function Promise$_Race(promises, parent) {
    var maybePromise = cast(promises, void 0);

    if (maybePromise instanceof Promise) {
        return raceLater(maybePromise);
    } else if (!isArray(promises)) {
        return apiRejection("expecting an array, a promise or a thenable");
    }

    var ret = new Promise(INTERNAL);
    if (parent !== void 0) {
        ret._propagateFrom(parent, 7);
    } else {
        ret._setTrace(void 0);
    }
    var fulfill = ret._fulfill;
    var reject = ret._reject;
    for (var i = 0, len = promises.length; i < len; ++i) {
        var val = promises[i];

        if (val === void 0 && !(hasOwn.call(promises, i))) {
            continue;
        }

        Promise.cast(val)._then(fulfill, reject, void 0, ret, null);
    }
    return ret;
}

Promise.race = function Promise$Race(promises) {
    return Promise$_Race(promises, void 0);
};

Promise.prototype.race = function Promise$race() {
    return Promise$_Race(this, void 0);
};

};

},{"./errors_api_rejection.js":16,"./util.js":40}],32:[function(require,module,exports){
/**
 * The MIT License (MIT)
 * 
 * Copyright (c) 2014 Petka Antonov
 * 
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:</p>
 * 
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * 
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.  IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 * 
 */
"use strict";
module.exports = function(Promise, PromiseArray, apiRejection, cast, INTERNAL) {
var util = require("./util.js");
var tryCatch4 = util.tryCatch4;
var tryCatch3 = util.tryCatch3;
var errorObj = util.errorObj;
function ReductionPromiseArray(promises, fn, accum, _each) {
    this.constructor$(promises);
    this._preservedValues = _each === INTERNAL ? [] : null;
    this._zerothIsAccum = (accum === void 0);
    this._gotAccum = false;
    this._reducingIndex = (this._zerothIsAccum ? 1 : 0);
    this._valuesPhase = undefined;

    var maybePromise = cast(accum, void 0);
    var rejected = false;
    var isPromise = maybePromise instanceof Promise;
    if (isPromise) {
        if (maybePromise.isPending()) {
            maybePromise._proxyPromiseArray(this, -1);
        } else if (maybePromise.isFulfilled()) {
            accum = maybePromise.value();
            this._gotAccum = true;
        } else {
            maybePromise._unsetRejectionIsUnhandled();
            this._reject(maybePromise.reason());
            rejected = true;
        }
    }
    if (!(isPromise || this._zerothIsAccum)) this._gotAccum = true;
    this._callback = fn;
    this._accum = accum;
    if (!rejected) this._init$(void 0, -5);
}
util.inherits(ReductionPromiseArray, PromiseArray);

ReductionPromiseArray.prototype._init =
function ReductionPromiseArray$_init() {};

ReductionPromiseArray.prototype._resolveEmptyArray =
function ReductionPromiseArray$_resolveEmptyArray() {
    if (this._gotAccum || this._zerothIsAccum) {
        this._resolve(this._preservedValues !== null
                        ? [] : this._accum);
    }
};

ReductionPromiseArray.prototype._promiseFulfilled =
function ReductionPromiseArray$_promiseFulfilled(value, index) {
    var values = this._values;
    if (values === null) return;
    var length = this.length();
    var preservedValues = this._preservedValues;
    var isEach = preservedValues !== null;
    var gotAccum = this._gotAccum;
    var valuesPhase = this._valuesPhase;
    var valuesPhaseIndex;
    if (!valuesPhase) {
        valuesPhase = this._valuesPhase = Array(length);
        for (valuesPhaseIndex=0; valuesPhaseIndex<length; ++valuesPhaseIndex) {
            valuesPhase[valuesPhaseIndex] = 0;
        }
    }
    valuesPhaseIndex = valuesPhase[index];

    if (index === 0 && this._zerothIsAccum) {
        if (!gotAccum) {
            this._accum = value;
            this._gotAccum = gotAccum = true;
        }
        valuesPhase[index] = ((valuesPhaseIndex === 0)
            ? 1 : 2);
    } else if (index === -1) {
        if (!gotAccum) {
            this._accum = value;
            this._gotAccum = gotAccum = true;
        }
    } else {
        if (valuesPhaseIndex === 0) {
            valuesPhase[index] = 1;
        }
        else {
            valuesPhase[index] = 2;
            if (gotAccum) {
                this._accum = value;
            }
        }
    }
    if (!gotAccum) return;

    var callback = this._callback;
    var receiver = this._promise._boundTo;
    var ret;

    for (var i = this._reducingIndex; i < length; ++i) {
        valuesPhaseIndex = valuesPhase[i];
        if (valuesPhaseIndex === 2) {
            this._reducingIndex = i + 1;
            continue;
        }
        if (valuesPhaseIndex !== 1) return;

        value = values[i];
        if (value instanceof Promise) {
            if (value.isFulfilled()) {
                value = value._settledValue;
            } else if (value.isPending()) {
                return;
            } else {
                value._unsetRejectionIsUnhandled();
                return this._reject(value.reason());
            }
        }

        if (isEach) {
            preservedValues.push(value);
            ret = tryCatch3(callback, receiver, value, i, length);
        }
        else {
            ret = tryCatch4(callback, receiver, this._accum, value, i, length);
        }

        if (ret === errorObj) return this._reject(ret.e);

        var maybePromise = cast(ret, void 0);
        if (maybePromise instanceof Promise) {
            if (maybePromise.isPending()) {
                valuesPhase[i] = 4;
                return maybePromise._proxyPromiseArray(this, i);
            } else if (maybePromise.isFulfilled()) {
                ret = maybePromise.value();
            } else {
                maybePromise._unsetRejectionIsUnhandled();
                return this._reject(maybePromise.reason());
            }
        }

        this._reducingIndex = i + 1;
        this._accum = ret;
    }

    if (this._reducingIndex < length) return;
    this._resolve(isEach ? preservedValues : this._accum);
};

function reduce(promises, fn, initialValue, _each) {
    if (typeof fn !== "function") return apiRejection("fn must be a function");
    var array = new ReductionPromiseArray(promises, fn, initialValue, _each);
    return array.promise();
}

Promise.prototype.reduce = function Promise$reduce(fn, initialValue) {
    return reduce(this, fn, initialValue, null);
};

Promise.reduce = function Promise$Reduce(promises, fn, initialValue, _each) {
    return reduce(promises, fn, initialValue, _each);
};
};

},{"./util.js":40}],33:[function(require,module,exports){
(function (process){
/**
 * The MIT License (MIT)
 * 
 * Copyright (c) 2014 Petka Antonov
 * 
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:</p>
 * 
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * 
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.  IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 * 
 */
"use strict";
var schedule;
var _MutationObserver;
if (typeof process === "object" && typeof process.version === "string") {
    schedule = function Promise$_Scheduler(fn) {
        process.nextTick(fn);
    };
}
else if ((typeof MutationObserver !== "undefined" &&
         (_MutationObserver = MutationObserver)) ||
         (typeof WebKitMutationObserver !== "undefined" &&
         (_MutationObserver = WebKitMutationObserver))) {
    schedule = (function() {
        var div = document.createElement("div");
        var queuedFn = void 0;
        var observer = new _MutationObserver(
            function Promise$_Scheduler() {
                var fn = queuedFn;
                queuedFn = void 0;
                fn();
            }
       );
        observer.observe(div, {
            attributes: true
        });
        return function Promise$_Scheduler(fn) {
            queuedFn = fn;
            div.classList.toggle("foo");
        };

    })();
}
else if (typeof setTimeout !== "undefined") {
    schedule = function Promise$_Scheduler(fn) {
        setTimeout(fn, 0);
    };
}
else throw new Error("no async scheduler available");
module.exports = schedule;

}).call(this,require('_process'))

},{"_process":43}],34:[function(require,module,exports){
/**
 * The MIT License (MIT)
 * 
 * Copyright (c) 2014 Petka Antonov
 * 
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:</p>
 * 
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * 
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.  IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 * 
 */
"use strict";
module.exports =
    function(Promise, PromiseArray) {
var PromiseInspection = Promise.PromiseInspection;
var util = require("./util.js");

function SettledPromiseArray(values) {
    this.constructor$(values);
}
util.inherits(SettledPromiseArray, PromiseArray);

SettledPromiseArray.prototype._promiseResolved =
function SettledPromiseArray$_promiseResolved(index, inspection) {
    this._values[index] = inspection;
    var totalResolved = ++this._totalResolved;
    if (totalResolved >= this._length) {
        this._resolve(this._values);
    }
};

SettledPromiseArray.prototype._promiseFulfilled =
function SettledPromiseArray$_promiseFulfilled(value, index) {
    if (this._isResolved()) return;
    var ret = new PromiseInspection();
    ret._bitField = 268435456;
    ret._settledValue = value;
    this._promiseResolved(index, ret);
};
SettledPromiseArray.prototype._promiseRejected =
function SettledPromiseArray$_promiseRejected(reason, index) {
    if (this._isResolved()) return;
    var ret = new PromiseInspection();
    ret._bitField = 134217728;
    ret._settledValue = reason;
    this._promiseResolved(index, ret);
};

Promise.settle = function Promise$Settle(promises) {
    return new SettledPromiseArray(promises).promise();
};

Promise.prototype.settle = function Promise$settle() {
    return new SettledPromiseArray(this).promise();
};
};

},{"./util.js":40}],35:[function(require,module,exports){
/**
 * The MIT License (MIT)
 * 
 * Copyright (c) 2014 Petka Antonov
 * 
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:</p>
 * 
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * 
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.  IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 * 
 */
"use strict";
module.exports =
function(Promise, PromiseArray, apiRejection) {
var util = require("./util.js");
var RangeError = require("./errors.js").RangeError;
var AggregateError = require("./errors.js").AggregateError;
var isArray = util.isArray;


function SomePromiseArray(values) {
    this.constructor$(values);
    this._howMany = 0;
    this._unwrap = false;
    this._initialized = false;
}
util.inherits(SomePromiseArray, PromiseArray);

SomePromiseArray.prototype._init = function SomePromiseArray$_init() {
    if (!this._initialized) {
        return;
    }
    if (this._howMany === 0) {
        this._resolve([]);
        return;
    }
    this._init$(void 0, -5);
    var isArrayResolved = isArray(this._values);
    if (!this._isResolved() &&
        isArrayResolved &&
        this._howMany > this._canPossiblyFulfill()) {
        this._reject(this._getRangeError(this.length()));
    }
};

SomePromiseArray.prototype.init = function SomePromiseArray$init() {
    this._initialized = true;
    this._init();
};

SomePromiseArray.prototype.setUnwrap = function SomePromiseArray$setUnwrap() {
    this._unwrap = true;
};

SomePromiseArray.prototype.howMany = function SomePromiseArray$howMany() {
    return this._howMany;
};

SomePromiseArray.prototype.setHowMany =
function SomePromiseArray$setHowMany(count) {
    if (this._isResolved()) return;
    this._howMany = count;
};

SomePromiseArray.prototype._promiseFulfilled =
function SomePromiseArray$_promiseFulfilled(value) {
    if (this._isResolved()) return;
    this._addFulfilled(value);
    if (this._fulfilled() === this.howMany()) {
        this._values.length = this.howMany();
        if (this.howMany() === 1 && this._unwrap) {
            this._resolve(this._values[0]);
        } else {
            this._resolve(this._values);
        }
    }

};
SomePromiseArray.prototype._promiseRejected =
function SomePromiseArray$_promiseRejected(reason) {
    if (this._isResolved()) return;
    this._addRejected(reason);
    if (this.howMany() > this._canPossiblyFulfill()) {
        var e = new AggregateError();
        for (var i = this.length(); i < this._values.length; ++i) {
            e.push(this._values[i]);
        }
        this._reject(e);
    }
};

SomePromiseArray.prototype._fulfilled = function SomePromiseArray$_fulfilled() {
    return this._totalResolved;
};

SomePromiseArray.prototype._rejected = function SomePromiseArray$_rejected() {
    return this._values.length - this.length();
};

SomePromiseArray.prototype._addRejected =
function SomePromiseArray$_addRejected(reason) {
    this._values.push(reason);
};

SomePromiseArray.prototype._addFulfilled =
function SomePromiseArray$_addFulfilled(value) {
    this._values[this._totalResolved++] = value;
};

SomePromiseArray.prototype._canPossiblyFulfill =
function SomePromiseArray$_canPossiblyFulfill() {
    return this.length() - this._rejected();
};

SomePromiseArray.prototype._getRangeError =
function SomePromiseArray$_getRangeError(count) {
    var message = "Input array must contain at least " +
            this._howMany + " items but contains only " + count + " items";
    return new RangeError(message);
};

SomePromiseArray.prototype._resolveEmptyArray =
function SomePromiseArray$_resolveEmptyArray() {
    this._reject(this._getRangeError(0));
};

function Promise$_Some(promises, howMany) {
    if ((howMany | 0) !== howMany || howMany < 0) {
        return apiRejection("expecting a positive integer");
    }
    var ret = new SomePromiseArray(promises);
    var promise = ret.promise();
    if (promise.isRejected()) {
        return promise;
    }
    ret.setHowMany(howMany);
    ret.init();
    return promise;
}

Promise.some = function Promise$Some(promises, howMany) {
    return Promise$_Some(promises, howMany);
};

Promise.prototype.some = function Promise$some(howMany) {
    return Promise$_Some(this, howMany);
};

Promise._SomePromiseArray = SomePromiseArray;
};

},{"./errors.js":15,"./util.js":40}],36:[function(require,module,exports){
/**
 * The MIT License (MIT)
 * 
 * Copyright (c) 2014 Petka Antonov
 * 
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:</p>
 * 
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * 
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.  IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 * 
 */
"use strict";
module.exports = function(Promise) {
function PromiseInspection(promise) {
    if (promise !== void 0) {
        this._bitField = promise._bitField;
        this._settledValue = promise.isResolved()
            ? promise._settledValue
            : void 0;
    }
    else {
        this._bitField = 0;
        this._settledValue = void 0;
    }
}

PromiseInspection.prototype.isFulfilled =
Promise.prototype.isFulfilled = function Promise$isFulfilled() {
    return (this._bitField & 268435456) > 0;
};

PromiseInspection.prototype.isRejected =
Promise.prototype.isRejected = function Promise$isRejected() {
    return (this._bitField & 134217728) > 0;
};

PromiseInspection.prototype.isPending =
Promise.prototype.isPending = function Promise$isPending() {
    return (this._bitField & 402653184) === 0;
};

PromiseInspection.prototype.value =
Promise.prototype.value = function Promise$value() {
    if (!this.isFulfilled()) {
        throw new TypeError("cannot get fulfillment value of a non-fulfilled promise");
    }
    return this._settledValue;
};

PromiseInspection.prototype.error =
PromiseInspection.prototype.reason =
Promise.prototype.reason = function Promise$reason() {
    if (!this.isRejected()) {
        throw new TypeError("cannot get rejection reason of a non-rejected promise");
    }
    return this._settledValue;
};

PromiseInspection.prototype.isResolved =
Promise.prototype.isResolved = function Promise$isResolved() {
    return (this._bitField & 402653184) > 0;
};

Promise.PromiseInspection = PromiseInspection;
};

},{}],37:[function(require,module,exports){
/**
 * The MIT License (MIT)
 * 
 * Copyright (c) 2014 Petka Antonov
 * 
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:</p>
 * 
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * 
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.  IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 * 
 */
"use strict";
module.exports = function(Promise, INTERNAL) {
var util = require("./util.js");
var canAttach = require("./errors.js").canAttach;
var errorObj = util.errorObj;
var isObject = util.isObject;

function getThen(obj) {
    try {
        return obj.then;
    }
    catch(e) {
        errorObj.e = e;
        return errorObj;
    }
}

function Promise$_Cast(obj, originalPromise) {
    if (isObject(obj)) {
        if (obj instanceof Promise) {
            return obj;
        }
        else if (isAnyBluebirdPromise(obj)) {
            var ret = new Promise(INTERNAL);
            ret._setTrace(void 0);
            obj._then(
                ret._fulfillUnchecked,
                ret._rejectUncheckedCheckError,
                ret._progressUnchecked,
                ret,
                null
            );
            ret._setFollowing();
            return ret;
        }
        var then = getThen(obj);
        if (then === errorObj) {
            if (originalPromise !== void 0 && canAttach(then.e)) {
                originalPromise._attachExtraTrace(then.e);
            }
            return Promise.reject(then.e);
        } else if (typeof then === "function") {
            return Promise$_doThenable(obj, then, originalPromise);
        }
    }
    return obj;
}

var hasProp = {}.hasOwnProperty;
function isAnyBluebirdPromise(obj) {
    return hasProp.call(obj, "_promise0");
}

function Promise$_doThenable(x, then, originalPromise) {
    var resolver = Promise.defer();
    var called = false;
    try {
        then.call(
            x,
            Promise$_resolveFromThenable,
            Promise$_rejectFromThenable,
            Promise$_progressFromThenable
        );
    } catch(e) {
        if (!called) {
            called = true;
            var trace = canAttach(e) ? e : new Error(e + "");
            if (originalPromise !== void 0) {
                originalPromise._attachExtraTrace(trace);
            }
            resolver.promise._reject(e, trace);
        }
    }
    return resolver.promise;

    function Promise$_resolveFromThenable(y) {
        if (called) return;
        called = true;

        if (x === y) {
            var e = Promise._makeSelfResolutionError();
            if (originalPromise !== void 0) {
                originalPromise._attachExtraTrace(e);
            }
            resolver.promise._reject(e, void 0);
            return;
        }
        resolver.resolve(y);
    }

    function Promise$_rejectFromThenable(r) {
        if (called) return;
        called = true;
        var trace = canAttach(r) ? r : new Error(r + "");
        if (originalPromise !== void 0) {
            originalPromise._attachExtraTrace(trace);
        }
        resolver.promise._reject(r, trace);
    }

    function Promise$_progressFromThenable(v) {
        if (called) return;
        var promise = resolver.promise;
        if (typeof promise._progress === "function") {
            promise._progress(v);
        }
    }
}

return Promise$_Cast;
};

},{"./errors.js":15,"./util.js":40}],38:[function(require,module,exports){
/**
 * The MIT License (MIT)
 * 
 * Copyright (c) 2014 Petka Antonov
 * 
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:</p>
 * 
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * 
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.  IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 * 
 */
"use strict";
var _setTimeout = function(fn, ms) {
    var len = arguments.length;
    var arg0 = arguments[2];
    var arg1 = arguments[3];
    var arg2 = len >= 5 ? arguments[4] : void 0;
    return setTimeout(function() {
        fn(arg0, arg1, arg2);
    }, ms|0);
};

module.exports = function(Promise, INTERNAL, cast) {
var util = require("./util.js");
var errors = require("./errors.js");
var apiRejection = require("./errors_api_rejection")(Promise);
var TimeoutError = Promise.TimeoutError;

var afterTimeout = function Promise$_afterTimeout(promise, message, ms) {
    if (!promise.isPending()) return;
    if (typeof message !== "string") {
        message = "operation timed out after" + " " + ms + " ms"
    }
    var err = new TimeoutError(message);
    errors.markAsOriginatingFromRejection(err);
    promise._attachExtraTrace(err);
    promise._cancel(err);
};

var afterDelay = function Promise$_afterDelay(value, promise) {
    promise._fulfill(value);
};

var delay = Promise.delay = function Promise$Delay(value, ms) {
    if (ms === void 0) {
        ms = value;
        value = void 0;
    }
    ms = +ms;
    var maybePromise = cast(value, void 0);
    var promise = new Promise(INTERNAL);

    if (maybePromise instanceof Promise) {
        promise._propagateFrom(maybePromise, 7);
        promise._follow(maybePromise);
        return promise.then(function(value) {
            return Promise.delay(value, ms);
        });
    } else {
        promise._setTrace(void 0);
        _setTimeout(afterDelay, ms, value, promise);
    }
    return promise;
};

Promise.prototype.delay = function Promise$delay(ms) {
    return delay(this, ms);
};

function successClear(value) {
    var handle = this;
    if (handle instanceof Number) handle = +handle;
    clearTimeout(handle);
    return value;
}

function failureClear(reason) {
    var handle = this;
    if (handle instanceof Number) handle = +handle;
    clearTimeout(handle);
    throw reason;
}

Promise.prototype.timeout = function Promise$timeout(ms, message) {
    ms = +ms;

    var ret = new Promise(INTERNAL);
    ret._propagateFrom(this, 7);
    ret._follow(this);
    var handle = _setTimeout(afterTimeout, ms, ret, message, ms);
    return ret.cancellable()
              ._then(successClear, failureClear, void 0, handle, void 0);
};

};

},{"./errors.js":15,"./errors_api_rejection":16,"./util.js":40}],39:[function(require,module,exports){
/**
 * The MIT License (MIT)
 * 
 * Copyright (c) 2014 Petka Antonov
 * 
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:</p>
 * 
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * 
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.  IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 * 
 */
"use strict";
module.exports = function (Promise, apiRejection, cast) {
    var TypeError = require("./errors.js").TypeError;
    var inherits = require("./util.js").inherits;
    var PromiseInspection = Promise.PromiseInspection;

    function inspectionMapper(inspections) {
        var len = inspections.length;
        for (var i = 0; i < len; ++i) {
            var inspection = inspections[i];
            if (inspection.isRejected()) {
                return Promise.reject(inspection.error());
            }
            inspections[i] = inspection.value();
        }
        return inspections;
    }

    function thrower(e) {
        setTimeout(function(){throw e;}, 0);
    }

    function castPreservingDisposable(thenable) {
        var maybePromise = cast(thenable, void 0);
        if (maybePromise !== thenable &&
            typeof thenable._isDisposable === "function" &&
            typeof thenable._getDisposer === "function" &&
            thenable._isDisposable()) {
            maybePromise._setDisposable(thenable._getDisposer());
        }
        return maybePromise;
    }
    function dispose(resources, inspection) {
        var i = 0;
        var len = resources.length;
        var ret = Promise.defer();
        function iterator() {
            if (i >= len) return ret.resolve();
            var maybePromise = castPreservingDisposable(resources[i++]);
            if (maybePromise instanceof Promise &&
                maybePromise._isDisposable()) {
                try {
                    maybePromise = cast(maybePromise._getDisposer()
                                        .tryDispose(inspection), void 0);
                } catch (e) {
                    return thrower(e);
                }
                if (maybePromise instanceof Promise) {
                    return maybePromise._then(iterator, thrower,
                                              null, null, null);
                }
            }
            iterator();
        }
        iterator();
        return ret.promise;
    }

    function disposerSuccess(value) {
        var inspection = new PromiseInspection();
        inspection._settledValue = value;
        inspection._bitField = 268435456;
        return dispose(this, inspection).thenReturn(value);
    }

    function disposerFail(reason) {
        var inspection = new PromiseInspection();
        inspection._settledValue = reason;
        inspection._bitField = 134217728;
        return dispose(this, inspection).thenThrow(reason);
    }

    function Disposer(data, promise) {
        this._data = data;
        this._promise = promise;
    }

    Disposer.prototype.data = function Disposer$data() {
        return this._data;
    };

    Disposer.prototype.promise = function Disposer$promise() {
        return this._promise;
    };

    Disposer.prototype.resource = function Disposer$resource() {
        if (this.promise().isFulfilled()) {
            return this.promise().value();
        }
        return null;
    };

    Disposer.prototype.tryDispose = function(inspection) {
        var resource = this.resource();
        var ret = resource !== null
            ? this.doDispose(resource, inspection) : null;
        this._promise._unsetDisposable();
        this._data = this._promise = null;
        return ret;
    };

    Disposer.isDisposer = function Disposer$isDisposer(d) {
        return (d != null &&
                typeof d.resource === "function" &&
                typeof d.tryDispose === "function");
    };

    function FunctionDisposer(fn, promise) {
        this.constructor$(fn, promise);
    }
    inherits(FunctionDisposer, Disposer);

    FunctionDisposer.prototype.doDispose = function (resource, inspection) {
        var fn = this.data();
        return fn.call(resource, resource, inspection);
    };

    Promise.using = function Promise$using() {
        var len = arguments.length;
        if (len < 2) return apiRejection(
                        "you must pass at least 2 arguments to Promise.using");
        var fn = arguments[len - 1];
        if (typeof fn !== "function") return apiRejection("fn must be a function");
        len--;
        var resources = new Array(len);
        for (var i = 0; i < len; ++i) {
            var resource = arguments[i];
            if (Disposer.isDisposer(resource)) {
                var disposer = resource;
                resource = resource.promise();
                resource._setDisposable(disposer);
            }
            resources[i] = resource;
        }

        return Promise.settle(resources)
            .then(inspectionMapper)
            .spread(fn)
            ._then(disposerSuccess, disposerFail, void 0, resources, void 0);
    };

    Promise.prototype._setDisposable =
    function Promise$_setDisposable(disposer) {
        this._bitField = this._bitField | 262144;
        this._disposer = disposer;
    };

    Promise.prototype._isDisposable = function Promise$_isDisposable() {
        return (this._bitField & 262144) > 0;
    };

    Promise.prototype._getDisposer = function Promise$_getDisposer() {
        return this._disposer;
    };

    Promise.prototype._unsetDisposable = function Promise$_unsetDisposable() {
        this._bitField = this._bitField & (~262144);
        this._disposer = void 0;
    };

    Promise.prototype.disposer = function Promise$disposer(fn) {
        if (typeof fn === "function") {
            return new FunctionDisposer(fn, this);
        }
        throw new TypeError();
    };

};

},{"./errors.js":15,"./util.js":40}],40:[function(require,module,exports){
/**
 * The MIT License (MIT)
 * 
 * Copyright (c) 2014 Petka Antonov
 * 
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:</p>
 * 
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 * 
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.  IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 * 
 */
"use strict";
var es5 = require("./es5.js");
var haveGetters = (function(){
    try {
        var o = {};
        es5.defineProperty(o, "f", {
            get: function () {
                return 3;
            }
        });
        return o.f === 3;
    }
    catch (e) {
        return false;
    }

})();
var canEvaluate = typeof navigator == "undefined";
var errorObj = {e: {}};
function tryCatch1(fn, receiver, arg) {
    try { return fn.call(receiver, arg); }
    catch (e) {
        errorObj.e = e;
        return errorObj;
    }
}

function tryCatch2(fn, receiver, arg, arg2) {
    try { return fn.call(receiver, arg, arg2); }
    catch (e) {
        errorObj.e = e;
        return errorObj;
    }
}

function tryCatch3(fn, receiver, arg, arg2, arg3) {
    try { return fn.call(receiver, arg, arg2, arg3); }
    catch (e) {
        errorObj.e = e;
        return errorObj;
    }
}

function tryCatch4(fn, receiver, arg, arg2, arg3, arg4) {
    try { return fn.call(receiver, arg, arg2, arg3, arg4); }
    catch (e) {
        errorObj.e = e;
        return errorObj;
    }
}

function tryCatchApply(fn, args, receiver) {
    try { return fn.apply(receiver, args); }
    catch (e) {
        errorObj.e = e;
        return errorObj;
    }
}

var inherits = function(Child, Parent) {
    var hasProp = {}.hasOwnProperty;

    function T() {
        this.constructor = Child;
        this.constructor$ = Parent;
        for (var propertyName in Parent.prototype) {
            if (hasProp.call(Parent.prototype, propertyName) &&
                propertyName.charAt(propertyName.length-1) !== "$"
           ) {
                this[propertyName + "$"] = Parent.prototype[propertyName];
            }
        }
    }
    T.prototype = Parent.prototype;
    Child.prototype = new T();
    return Child.prototype;
};

function asString(val) {
    return typeof val === "string" ? val : ("" + val);
}

function isPrimitive(val) {
    return val == null || val === true || val === false ||
        typeof val === "string" || typeof val === "number";

}

function isObject(value) {
    return !isPrimitive(value);
}

function maybeWrapAsError(maybeError) {
    if (!isPrimitive(maybeError)) return maybeError;

    return new Error(asString(maybeError));
}

function withAppended(target, appendee) {
    var len = target.length;
    var ret = new Array(len + 1);
    var i;
    for (i = 0; i < len; ++i) {
        ret[i] = target[i];
    }
    ret[i] = appendee;
    return ret;
}

function getDataPropertyOrDefault(obj, key, defaultValue) {
    if (es5.isES5) {
        var desc = Object.getOwnPropertyDescriptor(obj, key);
        if (desc != null) {
            return desc.get == null && desc.set == null
                    ? desc.value
                    : defaultValue;
        }
    } else {
        return {}.hasOwnProperty.call(obj, key) ? obj[key] : void 0;
    }
}

function notEnumerableProp(obj, name, value) {
    if (isPrimitive(obj)) return obj;
    var descriptor = {
        value: value,
        configurable: true,
        enumerable: false,
        writable: true
    };
    es5.defineProperty(obj, name, descriptor);
    return obj;
}


var wrapsPrimitiveReceiver = (function() {
    return this !== "string";
}).call("string");

function thrower(r) {
    throw r;
}

var inheritedDataKeys = (function() {
    if (es5.isES5) {
        return function(obj, opts) {
            var ret = [];
            var visitedKeys = Object.create(null);
            var getKeys = Object(opts).includeHidden
                ? Object.getOwnPropertyNames
                : Object.keys;
            while (obj != null) {
                var keys;
                try {
                    keys = getKeys(obj);
                } catch (e) {
                    return ret;
                }
                for (var i = 0; i < keys.length; ++i) {
                    var key = keys[i];
                    if (visitedKeys[key]) continue;
                    visitedKeys[key] = true;
                    var desc = Object.getOwnPropertyDescriptor(obj, key);
                    if (desc != null && desc.get == null && desc.set == null) {
                        ret.push(key);
                    }
                }
                obj = es5.getPrototypeOf(obj);
            }
            return ret;
        };
    } else {
        return function(obj) {
            var ret = [];
            /*jshint forin:false */
            for (var key in obj) {
                ret.push(key);
            }
            return ret;
        };
    }

})();

function isClass(fn) {
    try {
        if (typeof fn === "function") {
            var keys = es5.keys(fn.prototype);
            return keys.length > 0 &&
                   !(keys.length === 1 && keys[0] === "constructor");
        }
        return false;
    } catch (e) {
        return false;
    }
}

function toFastProperties(obj) {
    /*jshint -W027*/
    function f() {}
    f.prototype = obj;
    return f;
    eval(obj);
}

var rident = /^[a-z$_][a-z$_0-9]*$/i;
function isIdentifier(str) {
    return rident.test(str);
}

function filledRange(count, prefix, suffix) {
    var ret = new Array(count);
    for(var i = 0; i < count; ++i) {
        ret[i] = prefix + i + suffix;
    }
    return ret;
}

var ret = {
    isClass: isClass,
    isIdentifier: isIdentifier,
    inheritedDataKeys: inheritedDataKeys,
    getDataPropertyOrDefault: getDataPropertyOrDefault,
    thrower: thrower,
    isArray: es5.isArray,
    haveGetters: haveGetters,
    notEnumerableProp: notEnumerableProp,
    isPrimitive: isPrimitive,
    isObject: isObject,
    canEvaluate: canEvaluate,
    errorObj: errorObj,
    tryCatch1: tryCatch1,
    tryCatch2: tryCatch2,
    tryCatch3: tryCatch3,
    tryCatch4: tryCatch4,
    tryCatchApply: tryCatchApply,
    inherits: inherits,
    withAppended: withAppended,
    asString: asString,
    maybeWrapAsError: maybeWrapAsError,
    wrapsPrimitiveReceiver: wrapsPrimitiveReceiver,
    toFastProperties: toFastProperties,
    filledRange: filledRange
};

module.exports = ret;

},{"./es5.js":17}],41:[function(require,module,exports){
/*jslint node:true*/
/*globals RTCPeerConnection, mozRTCPeerConnection, webkitRTCPeerConnection */
/*globals RTCSessionDescription, mozRTCSessionDescription */
/*globals RTCIceCandidate, mozRTCIceCandidate */
'use strict';

var myRTCPeerConnection = null;
var myRTCSessionDescription = null;
var myRTCIceCandidate = null;

var renameIceURLs = function (config) {
  if (!config) {
    return;
  }
  if (!config.iceServers) {
    return config;
  }
  config.iceServers.forEach(function (server) {
    server.url = server.urls;
    delete server.urls;
  });
  return config;
};

var fixChromeStatsResponse = function(response) {
  var standardReport = {};
  var reports = response.result();
  reports.forEach(function(report) {
    var standardStats = {
      id: report.id,
      timestamp: report.timestamp,
      type: report.type
    };
    report.names().forEach(function(name) {
      standardStats[name] = report.stat(name);
    });
    standardReport[standardStats.id] = standardStats;
  });

  return standardReport;
};

var sessionHasData = function(desc) {
  if (!desc) {
    return false;
  }
  var hasData = false;
  var prefix = 'm=application';
  desc.sdp.split('\n').forEach(function(line) {
    if (line.slice(0, prefix.length) === prefix) {
      hasData = true;
    }
  });
  return hasData;
};

// Unify PeerConnection Object.
if (typeof RTCPeerConnection !== 'undefined') {
  myRTCPeerConnection = RTCPeerConnection;
} else if (typeof mozRTCPeerConnection !== 'undefined') {
  myRTCPeerConnection = function (configuration, constraints) {
    // Firefox uses 'url' rather than 'urls' for RTCIceServer.urls
    var pc = new mozRTCPeerConnection(renameIceURLs(configuration), constraints);

    // Firefox doesn't fire 'onnegotiationneeded' when a data channel is created
    // https://bugzilla.mozilla.org/show_bug.cgi?id=840728
    var dataEnabled = false;
    var boundCreateDataChannel = pc.createDataChannel.bind(pc);
    pc.createDataChannel = function(label, dataChannelDict) {
      var dc = boundCreateDataChannel(label, dataChannelDict);
      if (!dataEnabled) {
        dataEnabled = true;
        if (pc.onnegotiationneeded &&
            !sessionHasData(pc.localDescription) &&
            !sessionHasData(pc.remoteDescription)) {
          var event = new Event('negotiationneeded');
          pc.onnegotiationneeded(event);
        }
      }
      return dc;
    };

    return pc;
  };
} else if (typeof webkitRTCPeerConnection !== 'undefined') {
  // Chrome returns a nonstandard, non-JSON-ifiable response from getStats.
  myRTCPeerConnection = function(configuration, constraints) {
    var pc = new webkitRTCPeerConnection(configuration, constraints);
    var boundGetStats = pc.getStats.bind(pc);
    pc.getStats = function(selector, successCallback, failureCallback) {
      var successCallbackWrapper = function(chromeStatsResponse) {
        successCallback(fixChromeStatsResponse(chromeStatsResponse));
      };
      // Chrome also takes its arguments in the wrong order.
      boundGetStats(successCallbackWrapper, failureCallback, selector);
    };
    return pc;
  };
}

// Unify SessionDescrption Object.
if (typeof RTCSessionDescription !== 'undefined') {
  myRTCSessionDescription = RTCSessionDescription;
} else if (typeof mozRTCSessionDescription !== 'undefined') {
  myRTCSessionDescription = mozRTCSessionDescription;
}

// Unify IceCandidate Object.
if (typeof RTCIceCandidate !== 'undefined') {
  myRTCIceCandidate = RTCIceCandidate;
} else if (typeof mozRTCIceCandidate !== 'undefined') {
  myRTCIceCandidate = mozRTCIceCandidate;
}

exports.RTCPeerConnection = myRTCPeerConnection;
exports.RTCSessionDescription = myRTCSessionDescription;
exports.RTCIceCandidate = myRTCIceCandidate;

},{}],42:[function(require,module,exports){
/**
 * Created by Julian on 12/10/2014.
 */
(function (exports) {

    // performance.now polyfill
    var perf = null;
    if (typeof performance === 'undefined') {
        perf = {};
    } else {
        perf = performance;
    }

    perf.now = perf.now || perf.mozNow || perf.msNow ||  perf.oNow || perf.webkitNow || Date.now ||
        function () {
            return new Date().getTime();
        };

    function swap(array, i, j) {
        if (i !== j) {
            var temp = array[i];
            array[i] = array[j];
            array[j] = temp;
        }
    }

    /*
    ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
     */

    var getRandomInt = exports.getRandomInt = function (min, max) {
        if (min > max) throw new Error("min must be smaller than max! {" + min + ">" + max + "}" );
        return Math.floor(Math.random() * (max - min + 1)) + min;
    };

    exports.sample = function (list, n) {
        var result = [], j,i = 0, L = n > list.length ? list.length : n, s = list.length - 1;
        for(;i<L;i++) {
            j = getRandomInt(i,s);
            swap(list,i,j);
            result.push(list[i]);
        }
        return result;
    };

    exports.isString = function(myVar) {
        return (typeof myVar === 'string' || myVar instanceof String)
    };

    exports.assertLength = function (arg, nbr) {
        if (arg.length === nbr) return true;
        else throw new Error("Wrong number of arguments: expected:" + nbr + ", but got: " + arg.length);
    };

    exports.guid = function () {
        var d = perf.now();
        var guid = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
            var r = (d + Math.random() * 16) % 16 | 0;
            d = Math.floor(d / 16);
            return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
        });
        return guid;
    };

    exports.timeDifferenceInMs = function (tsA, tsB) {
        if (tsA instanceof Date){
            tsA = tsA.getTime();
        }
        if (tsB instanceof Date){
            tsB = tsB.getTime();
        }
        return Math.abs(tsA - tsB);
    };

    /**
     * milliseconds to seconds
     * @param ms {Number} Millis
     */
    exports.msToS = function (ms) {
        return ms / 1000;
    };

    exports.isDefined = function (o) {
        if (o === null) return false;
        if (typeof o === "undefined") return false;
        return true;
    };

    /**
     * Shallow clone
     * @param list
     * @returns {Array|string|Blob}
     */
    exports.cloneArray = function (list) {
        return list.slice(0);
    }

    /**
     * removes the item at the position and reindexes the list
     * @param list
     * @param i
     * @returns {*}
     */
    exports.deletePosition = function (list, i) {
        if (i < 0 || i >= list.length) throw new Error("Out of bounds");
        list.splice(i,1);
        return list;
    };

    /**
     * Checks weather the the object implements the full interface or not
     * @param o {Object}
     */
    var implements = exports.implements = function (o, a) {
        if (Array.isArray(a)) {
            return implements.apply({},[o].concat(a));
        }
        var i = 1, methodName;
        while((methodName = arguments[i++])) {
            if (typeof o[methodName] !== "function") {
                return false;
            }
        }
        return true;
    };

    /**
     * Inherit stuff from parent
     * @param child
     * @param parent
     */
    exports.inherit = function (child, parent) {
        child.prototype = Object.create(parent.prototype);
    };

})(typeof exports === 'undefined' ? this['yUtils'] = {} : exports);
},{}],43:[function(require,module,exports){
// shim for using process in browser

var process = module.exports = {};
var queue = [];
var draining = false;

function drainQueue() {
    if (draining) {
        return;
    }
    draining = true;
    var currentQueue;
    var len = queue.length;
    while(len) {
        currentQueue = queue;
        queue = [];
        var i = -1;
        while (++i < len) {
            currentQueue[i]();
        }
        len = queue.length;
    }
    draining = false;
}
process.nextTick = function (fun) {
    queue.push(fun);
    if (!draining) {
        setTimeout(drainQueue, 0);
    }
};

process.title = 'browser';
process.browser = true;
process.env = {};
process.argv = [];
process.version = ''; // empty string to avoid regexp issues

function noop() {}

process.on = noop;
process.addListener = noop;
process.once = noop;
process.off = noop;
process.removeListener = noop;
process.removeAllListeners = noop;
process.emit = noop;

process.binding = function (name) {
    throw new Error('process.binding is not supported');
};

// TODO(shtylman)
process.cwd = function () { return '/' };
process.chdir = function (dir) {
    throw new Error('process.chdir is not supported');
};
process.umask = function() { return 0; };

},{}]},{},[5])(5)
});
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uLy4uLy4uLy4uL3Vzci9sb2NhbC9saWIvbm9kZV9tb2R1bGVzL2Jyb3dzZXJpZnkvbm9kZV9tb2R1bGVzL2Jyb3dzZXItcGFjay9fcHJlbHVkZS5qcyIsImxpYi9BZGRyZXNzLmpzIiwibGliL01FU1NBR0VfVFlQRS5qcyIsImxpYi9QZWVyLmpzIiwibGliL1BlZXJDYWNoZS5qcyIsImxpYi9oYW5kc2hha2UuanMiLCJub2RlX21vZHVsZXMvYmx1ZWJpcmQvanMvbWFpbi9hbnkuanMiLCJub2RlX21vZHVsZXMvYmx1ZWJpcmQvanMvbWFpbi9hc3luYy5qcyIsIm5vZGVfbW9kdWxlcy9ibHVlYmlyZC9qcy9tYWluL2JsdWViaXJkLmpzIiwibm9kZV9tb2R1bGVzL2JsdWViaXJkL2pzL21haW4vY2FsbF9nZXQuanMiLCJub2RlX21vZHVsZXMvYmx1ZWJpcmQvanMvbWFpbi9jYW5jZWwuanMiLCJub2RlX21vZHVsZXMvYmx1ZWJpcmQvanMvbWFpbi9jYXB0dXJlZF90cmFjZS5qcyIsIm5vZGVfbW9kdWxlcy9ibHVlYmlyZC9qcy9tYWluL2NhdGNoX2ZpbHRlci5qcyIsIm5vZGVfbW9kdWxlcy9ibHVlYmlyZC9qcy9tYWluL2RpcmVjdF9yZXNvbHZlLmpzIiwibm9kZV9tb2R1bGVzL2JsdWViaXJkL2pzL21haW4vZWFjaC5qcyIsIm5vZGVfbW9kdWxlcy9ibHVlYmlyZC9qcy9tYWluL2Vycm9ycy5qcyIsIm5vZGVfbW9kdWxlcy9ibHVlYmlyZC9qcy9tYWluL2Vycm9yc19hcGlfcmVqZWN0aW9uLmpzIiwibm9kZV9tb2R1bGVzL2JsdWViaXJkL2pzL21haW4vZXM1LmpzIiwibm9kZV9tb2R1bGVzL2JsdWViaXJkL2pzL21haW4vZmlsdGVyLmpzIiwibm9kZV9tb2R1bGVzL2JsdWViaXJkL2pzL21haW4vZmluYWxseS5qcyIsIm5vZGVfbW9kdWxlcy9ibHVlYmlyZC9qcy9tYWluL2dlbmVyYXRvcnMuanMiLCJub2RlX21vZHVsZXMvYmx1ZWJpcmQvanMvbWFpbi9qb2luLmpzIiwibm9kZV9tb2R1bGVzL2JsdWViaXJkL2pzL21haW4vbWFwLmpzIiwibm9kZV9tb2R1bGVzL2JsdWViaXJkL2pzL21haW4vbm9kZWlmeS5qcyIsIm5vZGVfbW9kdWxlcy9ibHVlYmlyZC9qcy9tYWluL3Byb2dyZXNzLmpzIiwibm9kZV9tb2R1bGVzL2JsdWViaXJkL2pzL21haW4vcHJvbWlzZS5qcyIsIm5vZGVfbW9kdWxlcy9ibHVlYmlyZC9qcy9tYWluL3Byb21pc2VfYXJyYXkuanMiLCJub2RlX21vZHVsZXMvYmx1ZWJpcmQvanMvbWFpbi9wcm9taXNlX3Jlc29sdmVyLmpzIiwibm9kZV9tb2R1bGVzL2JsdWViaXJkL2pzL21haW4vcHJvbWlzaWZ5LmpzIiwibm9kZV9tb2R1bGVzL2JsdWViaXJkL2pzL21haW4vcHJvcHMuanMiLCJub2RlX21vZHVsZXMvYmx1ZWJpcmQvanMvbWFpbi9xdWV1ZS5qcyIsIm5vZGVfbW9kdWxlcy9ibHVlYmlyZC9qcy9tYWluL3JhY2UuanMiLCJub2RlX21vZHVsZXMvYmx1ZWJpcmQvanMvbWFpbi9yZWR1Y2UuanMiLCJub2RlX21vZHVsZXMvYmx1ZWJpcmQvanMvbWFpbi9zY2hlZHVsZS5qcyIsIm5vZGVfbW9kdWxlcy9ibHVlYmlyZC9qcy9tYWluL3NldHRsZS5qcyIsIm5vZGVfbW9kdWxlcy9ibHVlYmlyZC9qcy9tYWluL3NvbWUuanMiLCJub2RlX21vZHVsZXMvYmx1ZWJpcmQvanMvbWFpbi9zeW5jaHJvbm91c19pbnNwZWN0aW9uLmpzIiwibm9kZV9tb2R1bGVzL2JsdWViaXJkL2pzL21haW4vdGhlbmFibGVzLmpzIiwibm9kZV9tb2R1bGVzL2JsdWViaXJkL2pzL21haW4vdGltZXJzLmpzIiwibm9kZV9tb2R1bGVzL2JsdWViaXJkL2pzL21haW4vdXNpbmcuanMiLCJub2RlX21vZHVsZXMvYmx1ZWJpcmQvanMvbWFpbi91dGlsLmpzIiwibm9kZV9tb2R1bGVzL3dlYnJ0Yy1hZGFwdGVyL2FkYXB0ZXIuanMiLCJub2RlX21vZHVsZXMveXV0aWxzL3l1dGlscy5qcyIsIi4uLy4uLy4uLy4uLy4uL3Vzci9sb2NhbC9saWIvbm9kZV9tb2R1bGVzL2Jyb3dzZXJpZnkvbm9kZV9tb2R1bGVzL3Byb2Nlc3MvYnJvd3Nlci5qcyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiQUFBQTtBQ0FBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDSkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDVEE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDbE5BO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQzlFQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ3ZQQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7O0FDaERBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7OztBQ2pIQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDMUJBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDekhBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQzlFQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ3BQQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNoR0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ2hGQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUNwQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDbkpBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDeENBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUN6RkE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDcENBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUMxSEE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDekpBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDNUhBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDdkpBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQzlFQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7O0FDbEhBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7Ozs7QUN4a0NBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQzVNQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ2hLQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ3hVQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDOUdBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ3JIQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDMUVBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOzs7QUN2TEE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7Ozs7QUMvREE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDckVBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDbktBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQzlFQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUN2SUE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDNUdBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ2hNQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7QUM5UUE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7O0FDckhBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOztBQ3ZJQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQSIsImZpbGUiOiJnZW5lcmF0ZWQuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlc0NvbnRlbnQiOlsiKGZ1bmN0aW9uIGUodCxuLHIpe2Z1bmN0aW9uIHMobyx1KXtpZighbltvXSl7aWYoIXRbb10pe3ZhciBhPXR5cGVvZiByZXF1aXJlPT1cImZ1bmN0aW9uXCImJnJlcXVpcmU7aWYoIXUmJmEpcmV0dXJuIGEobywhMCk7aWYoaSlyZXR1cm4gaShvLCEwKTt2YXIgZj1uZXcgRXJyb3IoXCJDYW5ub3QgZmluZCBtb2R1bGUgJ1wiK28rXCInXCIpO3Rocm93IGYuY29kZT1cIk1PRFVMRV9OT1RfRk9VTkRcIixmfXZhciBsPW5bb109e2V4cG9ydHM6e319O3Rbb11bMF0uY2FsbChsLmV4cG9ydHMsZnVuY3Rpb24oZSl7dmFyIG49dFtvXVsxXVtlXTtyZXR1cm4gcyhuP246ZSl9LGwsbC5leHBvcnRzLGUsdCxuLHIpfXJldHVybiBuW29dLmV4cG9ydHN9dmFyIGk9dHlwZW9mIHJlcXVpcmU9PVwiZnVuY3Rpb25cIiYmcmVxdWlyZTtmb3IodmFyIG89MDtvPHIubGVuZ3RoO28rKylzKHJbb10pO3JldHVybiBzfSkiLCIvKipcclxuICogQ3JlYXRlZCBieSBKdWxpYW4gb24gMTIvMTcvMjAxNC5cclxuICovXHJcbnZhciBVdGlscyA9IHJlcXVpcmUoXCJ5dXRpbHNcIik7XHJcbmV4cG9ydHMuTG9jYWxBZGRyZXNzID0gVXRpbHMuZ3VpZCgpOyIsIi8qKlxyXG4gKiBDcmVhdGVkIGJ5IEp1bGlhbiBvbiAxMi8xNi8yMDE0LlxyXG4gKi9cclxuZXhwb3J0cy5NRVNTQUdFID0gMDtcclxuZXhwb3J0cy5URUxMX0FERFJFU1MgPSAxO1xyXG5leHBvcnRzLlJFUVVFU1RfTkVJR0hCT1JTID0gMjtcclxuZXhwb3J0cy5PRkZFUiA9IDM7XHJcbmV4cG9ydHMuQU5TV0VSID0gNDtcclxuZXhwb3J0cy5FUlJPUl9DQU5OT1RfRklORF9QRUVSID0gNTtcclxuZXhwb3J0cy5TRU5EX05FSUdIQk9SUyA9IDY7IiwiLyoqXHJcbiAqIENyZWF0ZWQgYnkgSnVsaWFuIG9uIDEyLzE2LzIwMTQuXHJcbiAqL1xyXG52YXIgV2ViUlRDID0gcmVxdWlyZShcIndlYnJ0Yy1hZGFwdGVyXCIpO1xyXG52YXIgUlRDUGVlckNvbm5lY3Rpb24gPSBXZWJSVEMuUlRDUGVlckNvbm5lY3Rpb247XHJcbnZhciBNRVNTQUdFX1RZUEUgPSByZXF1aXJlKFwiLi9NRVNTQUdFX1RZUEUuanNcIik7XHJcbnZhciBBRERSRVNTID0gcmVxdWlyZShcIi4vQWRkcmVzc1wiKS5Mb2NhbEFkZHJlc3M7XHJcbnZhciBQZWVyQ2FjaGUgPSByZXF1aXJlKFwiLi9QZWVyQ2FjaGVcIikuUGVlckNhY2hlO1xyXG52YXIgSGFuZHNoYWtlID0gcmVxdWlyZShcIi4vaGFuZHNoYWtlLmpzXCIpO1xyXG52YXIgUHJvbWlzZSA9IHJlcXVpcmUoXCJibHVlYmlyZFwiKTtcclxuXHJcbnZhciBSRVFVRVNUX05FSUdIQk9SU19USU1FT1VUX01TID0gNTAwMDtcclxuXHJcbnZhciBJQ0VfQ09ORklHID0ge1wiaWNlU2VydmVyc1wiOltcclxuICAgIHtcInVybFwiOlwic3R1bjoyMy4yMS4xNTAuMTIxXCJ9LFxyXG4gICAge1xyXG4gICAgICAgICd1cmwnOiAndHVybjoxOTIuMTU4LjI5LjM5OjM0Nzg/dHJhbnNwb3J0PXVkcCcsXHJcbiAgICAgICAgJ2NyZWRlbnRpYWwnOiAnSlpFT0V0MlYzUWIweTI3R1JudHQydTJQQVlBPScsXHJcbiAgICAgICAgJ3VzZXJuYW1lJzogJzI4MjI0NTExOjEzNzkzMzA4MDgnXHJcbiAgICB9XHJcbl19O1xyXG5cclxudmFyIENPTk4gPSB7ICdvcHRpb25hbCc6IFt7J0R0bHNTcnRwS2V5QWdyZWVtZW50JzogdHJ1ZX1dIH07XHJcblxyXG4vKipcclxuICpcclxuICogQGNvbnN0cnVjdG9yXHJcbiAqL1xyXG5mdW5jdGlvbiBQZWVyKCkge1xyXG4gICAgdmFyIHBjID0gbmV3IFJUQ1BlZXJDb25uZWN0aW9uKElDRV9DT05GSUcsIENPTk4pO1xyXG4gICAgdGhpcy5wYyA9IHBjO1xyXG4gICAgdGhpcy52ZXJib3NlID0gZmFsc2U7XHJcbiAgICB0aGlzLmFkZHJlc3MgPSBudWxsO1xyXG4gICAgdGhpcy5kYyA9IG51bGw7XHJcbiAgICB0aGlzLm9uT3BlbiA9IFtdO1xyXG4gICAgdGhpcy5vbk1lc3NhZ2UgPSBbXTtcclxuICAgIHRoaXMub25EaXNjb25uZWN0ID0gW107XHJcbiAgICB0aGlzLm9mZmVyQ2FsbGJhY2sgPSBudWxsO1xyXG4gICAgdGhpcy5jcmVhdGVDYWxsYmFjayA9IG51bGw7XHJcbiAgICB0aGlzLmljZVRpbWVvdXQgPSBudWxsO1xyXG4gICAgdGhpcy5vbkNhbm5vdEZpbmRQZWVyID0gW107XHJcbiAgICB0aGlzLnJlcXVlc3ROZWlnaGJvcnMgPSBudWxsO1xyXG4gICAgdGhpcy5yZXF1ZXN0TmVpZ2hib3JzQ2FsbGJhY2sgPSBudWxsO1xyXG4gICAgdmFyIHNlbGYgPSB0aGlzO1xyXG5cclxuICAgIHRoaXMuZGlzY29ubmVjdENvdW50ZXIgPSAwOyAvLyB0byBwcmV2ZW50IFwiZmFsc2VcIiBwb3NpdGl2ZS4uLlxyXG4gICAgdGhpcy50aHJlYWQgPSBzZXRJbnRlcnZhbChmdW5jdGlvbiAoKSB7XHJcbiAgICAgICAgdmFyIGkgPSAwLCBMID0gc2VsZi5vbkRpc2Nvbm5lY3QubGVuZ3RoO1xyXG4gICAgICAgIGlmIChzZWxmLmRjICE9PSBudWxsKSB7XHJcbiAgICAgICAgICAgIGlmKCBzZWxmLmRjLnJlYWR5U3RhdGUgPT09IFwiY2xvc2VkXCIpIHtcclxuICAgICAgICAgICAgICAgIGlmIChzZWxmLmRpc2Nvbm5lY3RDb3VudGVyID4gNSkge1xyXG4gICAgICAgICAgICAgICAgICAgIGZvcig7aTxMO2krKykge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBzZWxmLm9uRGlzY29ubmVjdFtpXS5jYWxsKHNlbGYpO1xyXG4gICAgICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgICAgICBjbGVhckludGVydmFsKHNlbGYudGhyZWFkKTtcclxuICAgICAgICAgICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICAgICAgICAgICAgc2VsZi5kaXNjb25uZWN0Q291bnRlciArPSAxO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICB9IGVsc2Uge1xyXG4gICAgICAgICAgICAgICAgc2VsZi5kaXNjb25uZWN0Q291bnRlciA9IDA7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICB9XHJcbiAgICB9LCAxMDApO1xyXG5cclxuICAgIC8qKlxyXG4gICAgICogcmV0dXJucyB0aGUgcmVzdWx0XHJcbiAgICAgKi9cclxuICAgIGZ1bmN0aW9uIGV4ZWMoKSB7XHJcbiAgICAgICAgY2xlYXJUaW1lb3V0KHNlbGYuaWNlVGltZW91dCk7XHJcbiAgICAgICAgdmFyIGQgPSBKU09OLnN0cmluZ2lmeShwYy5sb2NhbERlc2NyaXB0aW9uKTtcclxuICAgICAgICBpZiAoc2VsZi5vZmZlckNhbGxiYWNrICE9PSBudWxsKSB7XHJcbiAgICAgICAgICAgIHNlbGYub2ZmZXJDYWxsYmFjay5jYWxsKHNlbGYsIGQpO1xyXG4gICAgICAgICAgICBzZWxmLm9mZmVyQ2FsbGJhY2sgPSBudWxsO1xyXG4gICAgICAgIH0gZWxzZSBpZiAoc2VsZi5jcmVhdGVDYWxsYmFjayAhPT0gbnVsbCkge1xyXG4gICAgICAgICAgICBzZWxmLmNyZWF0ZUNhbGxiYWNrLmNhbGwoc2VsZiwgZCk7XHJcbiAgICAgICAgICAgIHNlbGYuY3JlYXRlQ2FsbGJhY2sgPSBudWxsO1xyXG4gICAgICAgIH1cclxuICAgICAgICBwYy5vbmljZWNhbmRpZGF0ZSA9IG51bGw7XHJcbiAgICB9XHJcblxyXG4gICAgcGMub25pY2VjYW5kaWRhdGUgPSBmdW5jdGlvbiAoZSkge1xyXG4gICAgICAgIGlmIChlLmNhbmRpZGF0ZSA9PT0gbnVsbCkge1xyXG4gICAgICAgICAgICBleGVjKCk7XHJcbiAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgICAgaWYgKHNlbGYuaWNlVGltZW91dCAhPT0gbnVsbCkge1xyXG4gICAgICAgICAgICAgICAgY2xlYXJUaW1lb3V0KHNlbGYuaWNlVGltZW91dCk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgc2VsZi5pY2VUaW1lb3V0ID0gc2V0VGltZW91dChmdW5jdGlvbiAoKSB7XHJcbiAgICAgICAgICAgICAgICBleGVjKCk7XHJcbiAgICAgICAgICAgIH0sIDEwMDApO1xyXG4gICAgICAgIH1cclxuICAgIH07XHJcblxyXG4gICAgLypcclxuICAgIHBjLm9ucGVlcmlkZW50aXR5ID0gZnVuY3Rpb24gKGUpIHtcclxuICAgICAgICAvL2NvbnNvbGUubG9nKFwicGVlciBpZGVudDpcIixlKTtcclxuICAgIH1cclxuXHJcbiAgICBwYy5vbnNpZ25hbGluZ3N0YXRlY2hhbmdlID0gZnVuY3Rpb24oZXYpIHtcclxuICAgICAgICAvL2NvbnNvbGUubG9nKFwib25zaWduYWxpbmdzdGF0ZWNoYW5nZSBldmVudCBkZXRlY3RlZCFcIiwgZXYpO1xyXG4gICAgfTtcclxuICAgICovXHJcbn1cclxuXHJcblBlZXIucHJvdG90eXBlLmlzT3BlbiA9IGZ1bmN0aW9uICgpIHtcclxuICAgIGlmICh0aGlzLnZlcmJvc2UpIHtcclxuICAgICAgICBjb25zb2xlLmxvZygnUGVlciB7JyArIHRoaXMuYWRkcmVzcyArICd9IGlzIG9wZW4uLi4nKTtcclxuICAgIH1cclxuICAgIGlmICh0aGlzLmRjICE9PSBudWxsKSB7XHJcbiAgICAgICAgcmV0dXJuIHRoaXMuZGMucmVhZHlTdGF0ZSA9PT0gXCJvcGVuXCI7XHJcbiAgICB9XHJcbiAgICByZXR1cm4gZmFsc2U7XHJcbn07XHJcblxyXG5QZWVyLnByb3RvdHlwZS5kaXNjb25uZWN0ID0gZnVuY3Rpb24gKCkge1xyXG4gICAgdGhpcy5kYy5jbG9zZSgpO1xyXG59O1xyXG5cclxuUGVlci5wcm90b3R5cGUub25kaXNjb25uZWN0ID0gZnVuY3Rpb24gKGNhbGxiYWNrKSB7XHJcbiAgICB0aGlzLm9uRGlzY29ubmVjdC5wdXNoKGNhbGxiYWNrKTtcclxufTtcclxuXHJcblBlZXIucHJvdG90eXBlLm9ub3BlbiA9IGZ1bmN0aW9uIChjYWxsYmFjaykge1xyXG4gICAgdGhpcy5vbk9wZW4ucHVzaChjYWxsYmFjayk7XHJcbn07XHJcblxyXG5QZWVyLnByb3RvdHlwZS5vbm1lc3NhZ2UgPSBmdW5jdGlvbiAoY2FsbGJhY2spIHtcclxuICAgIHRoaXMub25NZXNzYWdlLnB1c2goY2FsbGJhY2spO1xyXG59O1xyXG5cclxuUGVlci5wcm90b3R5cGUub25jYW5ub3RmaW5kcGVlciA9IGZ1bmN0aW9uIChjYWxsYmFjaykge1xyXG4gICAgdGhpcy5vbkNhbm5vdEZpbmRQZWVyLnB1c2goY2FsbGJhY2spO1xyXG59O1xyXG5cclxuLyoqXHJcbiAqIFNlbmQgYW55IGtpbmQgb2YgZGF0YSB0byB0aGUgb3RoZXIgUGVlclxyXG4gKiBAcGFyYW0gbWVzc2FnZVxyXG4gKi9cclxuUGVlci5wcm90b3R5cGUuc2VuZCA9IGZ1bmN0aW9uIChtZXNzYWdlKSB7XHJcbiAgICBpZiAodGhpcy5kYyA9PT0gbnVsbCB8fCB0aGlzLmRjLnJlYWR5U3RhdGUgIT09IFwib3BlblwiKSB7XHJcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKFwiSGFuZHNoYWtlIGluY29tcGxldGUhIFNlbmRpbmcgaXMgbm90IHBvc3NpYmxlLlwiKTtcclxuICAgIH1cclxuICAgIHRoaXMuZGMuc2VuZChKU09OLnN0cmluZ2lmeSh7dHlwZTogTUVTU0FHRV9UWVBFLk1FU1NBR0UsIHBheWxvYWQ6bWVzc2FnZSB9KSk7XHJcbiAgICBpZiAodGhpcy52ZXJib3NlKSB7XHJcbiAgICAgICAgY29uc29sZS5sb2coJ3NlbmQgdG8gUGVlciB7JyArIHRoaXMuYWRkcmVzcyArICd9IG1lc3NhZ2U6ICcsIG1lc3NhZ2UpO1xyXG4gICAgfVxyXG59O1xyXG5cclxuLyoqXHJcbiAqIFNlbmRzIGEgbWVzc2FnZSB3aXRob3V0IHBheWxvYWRcclxuICogQHBhcmFtIG1lc3NhZ2VUeXBlXHJcbiAqL1xyXG5QZWVyLnByb3RvdHlwZS5zZW5kTWVzc2FnZVR5cGUgPSBmdW5jdGlvbiAobWVzc2FnZVR5cGUsIHBheWxvYWQpIHtcclxuICAgIGlmICh0aGlzLmRjID09PSBudWxsIHx8IHRoaXMuZGMucmVhZHlTdGF0ZSAhPT0gXCJvcGVuXCIpIHtcclxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXCJIYW5kc2hha2UgaW5jb21wbGV0ZSEgU2VuZGluZyBpcyBub3QgcG9zc2libGUuXCIpO1xyXG4gICAgfVxyXG4gICAgaWYgKHR5cGVvZiBwYXlsb2FkID09PSBcInVuZGVmaW5lZFwiKSB7XHJcbiAgICAgICAgdGhpcy5kYy5zZW5kKEpTT04uc3RyaW5naWZ5KHt0eXBlOiBtZXNzYWdlVHlwZSB9KSk7XHJcbiAgICB9IGVsc2Uge1xyXG4gICAgICAgIHRoaXMuZGMuc2VuZChKU09OLnN0cmluZ2lmeSh7dHlwZTogbWVzc2FnZVR5cGUsIHBheWxvYWQ6IHBheWxvYWQgfSkpO1xyXG4gICAgfVxyXG4gICAgaWYgKHRoaXMudmVyYm9zZSkge1xyXG4gICAgICAgIGNvbnNvbGUubG9nKCdzZW5kIHRvIFBlZXIgeycgKyB0aGlzLmFkZHJlc3MgKyAnfSBtZXNzYWdlOiAnLCB7dHlwZTptZXNzYWdlVHlwZSwgcGF5bG9hZDpwYXlsb2FkfSk7XHJcbiAgICB9XHJcbn07XHJcblxyXG4vKipcclxuICogVHJpZXMgdG8gY29ubmVjdCB0byB0aGUgYWRkcmVzcyB0aHJvdWdoIHRoZSBwZWVyXHJcbiAqIEBwYXJhbSBhZGRyZXNzIHtTdHJpbmd9XHJcbiAqIEByZXR1cm5zIHtQZWVyfSByZXN1bHRpbmcgcGVlclxyXG4gKi9cclxuUGVlci5wcm90b3R5cGUuYXR0ZW1wdFRvQ29ubmVjdCA9IGZ1bmN0aW9uIChhZGRyZXNzKSB7XHJcbiAgICB2YXIgc2VsZiA9IHRoaXM7XHJcbiAgICB2YXIgb3RoZXIgPSBIYW5kc2hha2UuY3JlYXRlT2ZmZXIoZnVuY3Rpb24gKG9mZmVyKSB7XHJcbiAgICAgICAgc2VsZi5zZW5kTWVzc2FnZVR5cGUoTUVTU0FHRV9UWVBFLk9GRkVSLCB7b2ZmZXI6b2ZmZXIsIHRhcmdldDphZGRyZXNzLCBzb3VyY2U6QUREUkVTU30pO1xyXG4gICAgfSk7XHJcbiAgICBQZWVyQ2FjaGUucHV0UGVuZGluZyhvdGhlciwgYWRkcmVzcyk7XHJcbiAgICBpZiAodGhpcy52ZXJib3NlKSB7XHJcbiAgICAgICAgY29uc29sZS5sb2coJ2FzayBQZWVyIHsnICsgdGhpcy5hZGRyZXNzICsgJ30gdG8gY29ubmVjdCB1cyB3aXRoOiAnICsgYWRkcmVzcyk7XHJcbiAgICB9XHJcbiAgICByZXR1cm4gb3RoZXI7XHJcbn07XHJcblxyXG4vKipcclxuICpcclxuICogQHJldHVybnMge1Byb21pc2V9XHJcbiAqL1xyXG5QZWVyLnByb3RvdHlwZS5nZXROZWlnaGJvcnMgPSBmdW5jdGlvbiAoKSB7XHJcbiAgICBpZiAodGhpcy5yZXF1ZXN0TmVpZ2hib3JzICE9PSBudWxsKSB7XHJcbiAgICAgICAgY29uc29sZS53YXJuKFwiYWxyZWFkeSByZXF1ZXN0aW5nIG5laWdoYm9ycy4uIGNhbmNlbCBvbGQgcmVxdWVzdCFcIik7XHJcbiAgICAgICAgdGhpcy5yZXF1ZXN0TmVpZ2hib3JzLmNhbmNlbCgpO1xyXG4gICAgfVxyXG4gICAgdmFyIHNlbGYgPSB0aGlzO1xyXG4gICAgdGhpcy5yZXF1ZXN0TmVpZ2hib3JzID0gbmV3IFByb21pc2UoZnVuY3Rpb24gKHJlc29sdmUsIHJlamVjdCkge1xyXG4gICAgICAgIHZhciB0aW1lb3V0ID0gc2V0VGltZW91dChmdW5jdGlvbiAoKSB7XHJcbiAgICAgICAgICAgIHNlbGYucmVxdWVzdE5laWdoYm9ycyA9IG51bGw7XHJcbiAgICAgICAgICAgIHNlbGYucmVxdWVzdE5laWdoYm9yc0NhbGxiYWNrID0gbnVsbDtcclxuICAgICAgICAgICAgcmVqZWN0KCk7XHJcbiAgICAgICAgfSxSRVFVRVNUX05FSUdIQk9SU19USU1FT1VUX01TKTtcclxuICAgICAgICBzZWxmLnJlcXVlc3ROZWlnaGJvcnNDYWxsYmFjayA9IGZ1bmN0aW9uIChuZWlnaGJvcnMpIHtcclxuICAgICAgICAgICAgY2xlYXJUaW1lb3V0KHRpbWVvdXQpO1xyXG4gICAgICAgICAgICBzZWxmLnJlcXVlc3ROZWlnaGJvcnMgPSBudWxsO1xyXG4gICAgICAgICAgICBzZWxmLnJlcXVlc3ROZWlnaGJvcnNDYWxsYmFjayA9IG51bGw7XHJcbiAgICAgICAgICAgIHJlc29sdmUobmVpZ2hib3JzKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgc2VsZi5zZW5kTWVzc2FnZVR5cGUoTUVTU0FHRV9UWVBFLlJFUVVFU1RfTkVJR0hCT1JTKTtcclxuICAgIH0pLmNhbmNlbGxhYmxlKCk7XHJcbiAgICByZXR1cm4gdGhpcy5yZXF1ZXN0TmVpZ2hib3JzO1xyXG59O1xyXG5cclxuZXhwb3J0cy5QZWVyID0gUGVlcjsiLCIvKipcclxuICogQ2FjaGVzIGNvbm5lY3Rpb25zIHRoYXQgYXJlIG9wZW5lZCBhbmQgbm90IGNsb3NlZCB5ZXQgZm9yIHRoZSBwdXJwb3NlIG9mIHNpZ25hbGluZ1xyXG4gKlxyXG4gKiBDcmVhdGVkIGJ5IEp1bGlhbiBvbiAxMi8xNy8yMDE0LlxyXG4gKi9cclxudmFyIFV0aWxzID0gcmVxdWlyZShcInl1dGlsc1wiKTtcclxuXHJcbnZhciBjYWNoZSA9IHt9O1xyXG5cclxudmFyIHBlbmRpbmcgPSB7fTtcclxuXHJcbmV4cG9ydHMuUGVlckNhY2hlID0ge1xyXG5cclxuICAgIGdldEFsbEFkZHJlc3NlczogZnVuY3Rpb24gKCkge1xyXG4gICAgICAgIHJldHVybiBPYmplY3Qua2V5cyhjYWNoZSk7XHJcbiAgICB9LFxyXG5cclxuICAgIC8qKlxyXG4gICAgICogUHV0IGEgUGVlciB0aGF0IGlzIGFscmVhZHkgb3BlblxyXG4gICAgICogQHBhcmFtIHBlZXIge1BlZXJ9XHJcbiAgICAgKi9cclxuICAgIHB1dDogZnVuY3Rpb24gKHBlZXIpIHtcclxuICAgICAgICBpZiAoIXBlZXIuaXNPcGVuKCkpIHRocm93IG5ldyBFcnJvcihcIkNhbm5vdCBwdXQgbm90LW9wZW5lZCBwZWVycyBpbnRvIGNhY2hlIVwiKTtcclxuICAgICAgICBpZiAocGVlci5hZGRyZXNzIGluIGNhY2hlKSB0aHJvdyBuZXcgRXJyb3IoXCJDb25uZWN0aW9uIGlzIGFscmVhZHkgb3BlbiEgQ2Fubm90IHB1dCBpbnRvIGNhY2hlLlwiKTsgLy9UT0RPIHJlYWxseS4uP1xyXG5cclxuICAgICAgICBjYWNoZVtwZWVyLmFkZHJlc3NdID0gcGVlcjtcclxuXHJcbiAgICAgICAgLy8gQ2xlYXIgd2hlbiBkaXNjb25uZWN0ZWRcclxuICAgICAgICBwZWVyLm9uZGlzY29ubmVjdChmdW5jdGlvbiAoKSB7XHJcbiAgICAgICAgICAgIGRlbGV0ZSBjYWNoZVtwZWVyLmFkZHJlc3NdO1xyXG4gICAgICAgIH0pO1xyXG4gICAgfSxcclxuXHJcbiAgICBoYXM6IGZ1bmN0aW9uIChhZGRyZXNzKSB7XHJcbiAgICAgICAgcmV0dXJuIGFkZHJlc3MgaW4gY2FjaGU7XHJcbiAgICB9LFxyXG5cclxuICAgIGdldDogZnVuY3Rpb24gKGFkZHJlc3MpIHtcclxuICAgICAgICByZXR1cm4gY2FjaGVbYWRkcmVzc107XHJcbiAgICB9LFxyXG5cclxuICAgIHB1dFBlbmRpbmc6IGZ1bmN0aW9uIChwZWVyLCBhZGRyZXNzKSB7XHJcbiAgICAgICAgaWYgKHBlZXIuaXNPcGVuKCkpIHRocm93IG5ldyBFcnJvcihcIkNhbm5vdCBhdCBwZWVyIHRvIHBlbmRpbmcgYmVjYXVzZSBpdCBpcyBhbHJlYWR5IG9wZW4hXCIpO1xyXG4gICAgICAgIGlmIChhZGRyZXNzIGluIHBlbmRpbmcpIHRocm93IG5ldyBFcnJvcihcIkNvbm5lY3Rpb24gaXMgYWxyZWFkeSBwZW5kaW5nISBDYW5ub3QgcHV0IGludG8gY2FjaGUuXCIpOyAvL1RPRE8gcmVhbGx5Li4/XHJcblxyXG4gICAgICAgIHBlZXIub25vcGVuKGZ1bmN0aW9uICgpIHtcclxuICAgICAgICAgICAgZGVsZXRlIHBlbmRpbmdbYWRkcmVzc107XHJcbiAgICAgICAgfSk7XHJcblxyXG4gICAgICAgIHBlbmRpbmdbYWRkcmVzc10gPSB7cGVlcjogcGVlciwgdHM6IERhdGUubm93KCl9O1xyXG4gICAgfSxcclxuXHJcbiAgICBnZXRQZW5kaW5nOiBmdW5jdGlvbiAoYWRkcmVzcykge1xyXG4gICAgICAgIHJldHVybiBwZW5kaW5nW2FkZHJlc3NdLnBlZXI7XHJcbiAgICB9LFxyXG5cclxuICAgIGRlbGV0ZVBlbmRpbmc6IGZ1bmN0aW9uIChhZGRyZXNzKSB7XHJcbiAgICAgICAgZGVsZXRlIHBlbmRpbmdbYWRkcmVzc107XHJcblxyXG4gICAgfVxyXG5cclxufTtcclxuXHJcbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxyXG4vLyBDTEVBTiBQRU5ESU5HIENBQ0hFXHJcbi8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxyXG5zZXRJbnRlcnZhbChmdW5jdGlvbiAoKSB7XHJcbiAgICB2YXIga2V5LCBzLCBub3cgPSBEYXRlLm5vdygpLCBjdXJyZW50O1xyXG4gICAgZm9yKGtleSBpbiBwZW5kaW5nKSB7XHJcbiAgICAgICAgY3VycmVudCA9IHBlbmRpbmdba2V5XTtcclxuICAgICAgICBzID0gVXRpbHMubXNUb1MoVXRpbHMudGltZURpZmZlcmVuY2VJbk1zKGN1cnJlbnQudHMsIG5vdykpO1xyXG4gICAgICAgIGlmIChzID4gNjApIHtcclxuICAgICAgICAgICAgLy8gaWYgYSBjb25uZWN0aW9uIGlzIHBlbmRpbmcgZm9yIG1vcmUgdGhhbiAxIG1pbnV0ZSwgY2xvc2UgaXQuLlxyXG4gICAgICAgICAgICBjdXJyZW50LnBlZXIuZGlzY29ubmVjdCgpO1xyXG4gICAgICAgICAgICBkZWxldGUgcGVuZGluZ1trZXldO1xyXG4gICAgICAgIH1cclxuICAgIH1cclxufSwgMzAwMDApOyAvLyBldmVyeSAzMCBzZWNvbmRzXHJcbiIsIi8qKlxyXG4gKiBDcmVhdGVkIGJ5IEp1bGlhbiBvbiAxMi8xMS8yMDE0LlxyXG4gKi9cclxudmFyIFV0aWxzID0gcmVxdWlyZShcInl1dGlsc1wiKTtcclxudmFyIFBlZXIgPSByZXF1aXJlKFwiLi9QZWVyLmpzXCIpLlBlZXI7XHJcbnZhciBQZWVyQ2FjaGUgPSByZXF1aXJlKFwiLi9QZWVyQ2FjaGUuanNcIikuUGVlckNhY2hlO1xyXG52YXIgTUVTU0FHRV9UWVBFID0gcmVxdWlyZShcIi4vTUVTU0FHRV9UWVBFLmpzXCIpO1xyXG52YXIgQUREUkVTUyA9IHJlcXVpcmUoXCIuL0FkZHJlc3NcIikuTG9jYWxBZGRyZXNzO1xyXG5cclxudmFyIG9uUmVtb3RlQ29ubmVjdGlvbkNhbGxiYWNrcyA9IFtdO1xyXG52YXIgb25NZXNzYWdlQ2FsbGJhY2tzID0gW107XHJcblxyXG5mdW5jdGlvbiBvbk1lc3NhZ2UocGVlcikge1xyXG4gICAgcmV0dXJuIGZ1bmN0aW9uIChtc2cpIHtcclxuICAgICAgICB2YXIgaSA9IDAsIGNiID0gb25NZXNzYWdlQ2FsbGJhY2tzLCBMID0gY2IubGVuZ3RoO1xyXG4gICAgICAgIGZvcig7aTxMO2krKykge1xyXG4gICAgICAgICAgICBjYltpXS5jYWxsKHBlZXIsIHBlZXIsIG1zZyk7XHJcbiAgICAgICAgfVxyXG4gICAgfVxyXG59XHJcblxyXG4vKipcclxuICogQHR5cGUge09iamVjdH1cclxuICoge1xyXG4gKiAgICAgIGd1aWQxIDogcGVlcixcclxuICogICAgICBndWlkMiA6IHBlZXJcclxuICogfVxyXG4gKi9cclxuXHJcbi8qID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxyXG4gQSBQIElcclxuID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PSAqL1xyXG5cclxuLyoqXHJcbiAqIGluaXRpYXRlcyBhIFBlZXItdG8tUGVlciBjb25uZWN0aW9uXHJcbiAqIEBwYXJhbSBjYWxsYmFja1xyXG4gKiBAcmV0dXJucyB7UGVlcn1cclxuICovXHJcbmZ1bmN0aW9uIGNyZWF0ZU9mZmVyKGNhbGxiYWNrKSB7XHJcbiAgICB2YXIgcGVlciA9IG5ldyBQZWVyKCksIHBjID0gcGVlci5wYztcclxuICAgIHBlZXIub2ZmZXJDYWxsYmFjayA9IGNhbGxiYWNrO1xyXG5cclxuICAgIHZhciBkYyA9IHBjLmNyZWF0ZURhdGFDaGFubmVsKFwicVwiLCB7cmVsaWFibGU6dHJ1ZX0pO1xyXG4gICAgcGMuY3JlYXRlT2ZmZXIoZnVuY3Rpb24gKGRlc2MpIHtcclxuICAgICAgICBwYy5zZXRMb2NhbERlc2NyaXB0aW9uKGRlc2MsIGZ1bmN0aW9uKCkgeyB9KTtcclxuICAgIH0sIGZ1bmN0aW9uIGZhaWx1cmUoZSkgeyBjb25zb2xlLmVycm9yKGUpOyB9KTtcclxuXHJcbiAgICBkYy5vbm9wZW4gPSBmdW5jdGlvbiAoKSB7XHJcbiAgICAgICAgZGMuc2VuZChKU09OLnN0cmluZ2lmeSh7dHlwZTogTUVTU0FHRV9UWVBFLlRFTExfQUREUkVTUywgcGF5bG9hZDogQUREUkVTU30pKTtcclxuICAgIH07XHJcblxyXG4gICAgZGMub25tZXNzYWdlID0gaGFuZGxlTWVzc2FnZShwZWVyKTtcclxuXHJcbiAgICBwZWVyLmRjID0gZGM7XHJcbiAgICByZXR1cm4gcGVlcjtcclxufVxyXG5cclxuLyoqXHJcbiAqXHJcbiAqIEBwYXJhbSBwZWVyXHJcbiAqIEByZXR1cm5zIHtGdW5jdGlvbn1cclxuICovXHJcbmZ1bmN0aW9uIGhhbmRsZU1lc3NhZ2UocGVlcikge1xyXG4gICAgcmV0dXJuIGZ1bmN0aW9uIChlKSB7XHJcbiAgICAgICAgdmFyIG1zZyA9IFV0aWxzLmlzU3RyaW5nKGUuZGF0YSkgPyBKU09OLnBhcnNlKGUuZGF0YSkgOiBlLmRhdGE7XHJcbiAgICAgICAgdmFyIGksIEwsIG5ld1BlZXIsIGRlc3RpbmF0aW9uUGVlciwgbjtcclxuICAgICAgICBzd2l0Y2ggKG1zZy50eXBlKSB7XHJcbiAgICAgICAgICAgIGNhc2UgTUVTU0FHRV9UWVBFLk9GRkVSOlxyXG4gICAgICAgICAgICAgICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XHJcbiAgICAgICAgICAgICAgICAvLyBPIEYgRiBFIFJcclxuICAgICAgICAgICAgICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxyXG4gICAgICAgICAgICAgICAgaWYgKFwidGFyZ2V0XCIgaW4gbXNnLnBheWxvYWQpIHtcclxuICAgICAgICAgICAgICAgICAgICAvLyB3ZSBhcmUgdGhlIG1lZGlhdG9yXHJcbiAgICAgICAgICAgICAgICAgICAgaWYgKFBlZXJDYWNoZS5oYXMobXNnLnBheWxvYWQudGFyZ2V0KSkge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBkZXN0aW5hdGlvblBlZXIgPSBQZWVyQ2FjaGUuZ2V0KG1zZy5wYXlsb2FkLnRhcmdldCk7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGRlc3RpbmF0aW9uUGVlci5zZW5kTWVzc2FnZVR5cGUoTUVTU0FHRV9UWVBFLk9GRkVSLCB7b2ZmZXI6bXNnLnBheWxvYWQub2ZmZXIsIHNvdXJjZTptc2cucGF5bG9hZC5zb3VyY2V9KTtcclxuICAgICAgICAgICAgICAgICAgICB9IGVsc2Uge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAvLyB3ZSBjYW5ub3QgZXN0YWJsaXNoIGEgY29ubmVjdGlvbi4uXHJcbiAgICAgICAgICAgICAgICAgICAgICAgIHBlZXIuc2VuZE1lc3NhZ2VUeXBlKE1FU1NBR0VfVFlQRS5FUlJPUl9DQU5OT1RfRklORF9QRUVSLCBtc2cucGF5bG9hZC50YXJnZXQpO1xyXG4gICAgICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICAgICAgICAgICAgLy8gV0UgYXJlIHRoZSBUQVJHRVQhXHJcbiAgICAgICAgICAgICAgICAgICAgbmV3UGVlciA9IGNyZWF0ZUFuc3dlcihtc2cucGF5bG9hZC5vZmZlciwgZnVuY3Rpb24gKGFuc3dlcikge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBwZWVyLnNlbmRNZXNzYWdlVHlwZShcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIE1FU1NBR0VfVFlQRS5BTlNXRVIsIHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBhbnN3ZXI6IGFuc3dlcixcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBzb3VyY2U6IG1zZy5wYXlsb2FkLnNvdXJjZSxcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0YXJnZXQ6IEFERFJFU1NcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgICAgICAgICAgKTtcclxuICAgICAgICAgICAgICAgICAgICB9KTtcclxuICAgICAgICAgICAgICAgICAgICBpID0gMCwgTCA9IG9uUmVtb3RlQ29ubmVjdGlvbkNhbGxiYWNrcy5sZW5ndGg7XHJcbiAgICAgICAgICAgICAgICAgICAgZm9yKDtpPEw7aSsrKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIG9uUmVtb3RlQ29ubmVjdGlvbkNhbGxiYWNrc1tpXS5jYWxsKG5ld1BlZXIsbmV3UGVlcik7XHJcbiAgICAgICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgYnJlYWs7XHJcbiAgICAgICAgICAgIGNhc2UgTUVTU0FHRV9UWVBFLkFOU1dFUjpcclxuICAgICAgICAgICAgICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxyXG4gICAgICAgICAgICAgICAgLy8gQSBOIFMgVyBFIFJcclxuICAgICAgICAgICAgICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxyXG4gICAgICAgICAgICAgICAgaWYgKFwic291cmNlXCIgaW4gbXNnLnBheWxvYWQpIHtcclxuICAgICAgICAgICAgICAgICAgICAvLyB3ZSBhcmUgdGhlIG1lZGlhdG9yLi5cclxuICAgICAgICAgICAgICAgICAgICBpZiAoUGVlckNhY2hlLmhhcyhtc2cucGF5bG9hZC5zb3VyY2UpKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGRlc3RpbmF0aW9uUGVlciA9IFBlZXJDYWNoZS5nZXQobXNnLnBheWxvYWQuc291cmNlKTtcclxuICAgICAgICAgICAgICAgICAgICAgICAgZGVzdGluYXRpb25QZWVyLnNlbmRNZXNzYWdlVHlwZShNRVNTQUdFX1RZUEUuQU5TV0VSLCB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBhbnN3ZXI6IG1zZy5wYXlsb2FkLmFuc3dlcixcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRhcmdldDogbXNnLnBheWxvYWQudGFyZ2V0XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIH0pO1xyXG4gICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIHBlZXIuc2VuZE1lc3NhZ2VUeXBlKE1FU1NBR0VfVFlQRS5FUlJPUl9DQU5OT1RfRklORF9QRUVSLCBtc2cucGF5bG9hZC50YXJnZXQpO1xyXG4gICAgICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICAgICAgICAgICAgLy8gd2UgYXJlIHRoZSBTRU5ERVIgYW5kIHdlIGFyZSBzdXBwb3NlZCB0byBhcHBseSB0aGUgYW5zd2VyLi5cclxuICAgICAgICAgICAgICAgICAgICBkZXN0aW5hdGlvblBlZXIgPSBQZWVyQ2FjaGUuZ2V0UGVuZGluZyhtc2cucGF5bG9hZC50YXJnZXQpO1xyXG4gICAgICAgICAgICAgICAgICAgIGhhbmRsZUFuc3dlcihkZXN0aW5hdGlvblBlZXIsIG1zZy5wYXlsb2FkLmFuc3dlcik7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICBicmVhaztcclxuICAgICAgICAgICAgY2FzZSBNRVNTQUdFX1RZUEUuVEVMTF9BRERSRVNTOlxyXG4gICAgICAgICAgICAgICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XHJcbiAgICAgICAgICAgICAgICAvLyBUIEUgTCBMICBBIEQgRCBSIEUgUyBTXHJcbiAgICAgICAgICAgICAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cclxuICAgICAgICAgICAgICAgIHBlZXIuYWRkcmVzcyA9IG1zZy5wYXlsb2FkO1xyXG4gICAgICAgICAgICAgICAgaSA9IDAsIEwgPSBwZWVyLm9uT3Blbi5sZW5ndGg7XHJcbiAgICAgICAgICAgICAgICBQZWVyQ2FjaGUucHV0KHBlZXIpO1xyXG4gICAgICAgICAgICAgICAgcGVlci5vbm1lc3NhZ2Uob25NZXNzYWdlKHBlZXIpKTtcclxuICAgICAgICAgICAgICAgIGZvcig7aTxMO2krKykge1xyXG4gICAgICAgICAgICAgICAgICAgIHBlZXIub25PcGVuW2ldLmNhbGwocGVlcik7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICBwZWVyLm9uT3BlbiA9IG51bGw7XHJcbiAgICAgICAgICAgICAgICBicmVhaztcclxuICAgICAgICAgICAgY2FzZSBNRVNTQUdFX1RZUEUuTUVTU0FHRTpcclxuICAgICAgICAgICAgICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxyXG4gICAgICAgICAgICAgICAgLy8gTSBFIFMgUyBBIEcgRVxyXG4gICAgICAgICAgICAgICAgLy8gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09XHJcbiAgICAgICAgICAgICAgICBpID0gMCwgTCA9IHBlZXIub25NZXNzYWdlLmxlbmd0aDtcclxuICAgICAgICAgICAgICAgIGZvcig7aTxMO2krKykge1xyXG4gICAgICAgICAgICAgICAgICAgIHBlZXIub25NZXNzYWdlW2ldLmNhbGwocGVlciwgbXNnLnBheWxvYWQpO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgYnJlYWs7XHJcbiAgICAgICAgICAgIGNhc2UgTUVTU0FHRV9UWVBFLkVSUk9SX0NBTk5PVF9GSU5EX1BFRVI6XHJcbiAgICAgICAgICAgICAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cclxuICAgICAgICAgICAgICAgIC8vIEUgUiBSIE8gUiAgQyBBIE4gTiBPIFQgIEYgSSBOIEQgIFAgRSBFIFJcclxuICAgICAgICAgICAgICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxyXG4gICAgICAgICAgICAgICAgaT0wLCBMID0gcGVlci5vbkNhbm5vdEZpbmRQZWVyLmxlbmd0aDtcclxuICAgICAgICAgICAgICAgIFBlZXJDYWNoZS5kZWxldGVQZW5kaW5nKG1zZy5wYXlsb2FkKTtcclxuICAgICAgICAgICAgICAgIGZvciAoO2k8TDtpKyspIHtcclxuICAgICAgICAgICAgICAgICAgICBwZWVyLm9uQ2Fubm90RmluZFBlZXJbaV0uY2FsbChwZWVyLCBtc2cucGF5bG9hZCk7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICBicmVhaztcclxuICAgICAgICAgICAgY2FzZSBNRVNTQUdFX1RZUEUuUkVRVUVTVF9ORUlHSEJPUlM6XHJcbiAgICAgICAgICAgICAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cclxuICAgICAgICAgICAgICAgIC8vIFIgRSBRIFUgRSBTIFQgIE4gRSBJIEcgSCBCIE8gUiBTXHJcbiAgICAgICAgICAgICAgICAvLyA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cclxuICAgICAgICAgICAgICAgIHBlZXIuc2VuZE1lc3NhZ2VUeXBlKE1FU1NBR0VfVFlQRS5TRU5EX05FSUdIQk9SUywgUGVlckNhY2hlLmdldEFsbEFkZHJlc3NlcygpKTtcclxuICAgICAgICAgICAgICAgIGJyZWFrO1xyXG4gICAgICAgICAgICBjYXNlIE1FU1NBR0VfVFlQRS5TRU5EX05FSUdIQk9SUzpcclxuICAgICAgICAgICAgICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxyXG4gICAgICAgICAgICAgICAgLy8gUyBFIE4gRCAgTiBFIEkgRyBIIEIgTyBSIFNcclxuICAgICAgICAgICAgICAgIC8vID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PVxyXG4gICAgICAgICAgICAgICAgbiA9IFV0aWxzLmlzU3RyaW5nKG1zZy5wYXlsb2FkKT8gSlNPTi5wYXJzZShtc2cucGF5bG9hZCkgOiBtc2cucGF5bG9hZDtcclxuICAgICAgICAgICAgICAgIHBlZXIucmVxdWVzdE5laWdoYm9yc0NhbGxiYWNrLmNhbGwocGVlciwgbik7XHJcbiAgICAgICAgICAgICAgICBicmVhaztcclxuICAgICAgICB9XHJcbiAgICB9O1xyXG59XHJcblxyXG4vKipcclxuICogQWNjZXB0cyB0aGUgaW5pdGlhbCBQZWVyLXRvLVBlZXIgaW52aXRhdGlvblxyXG4gKiBAcGFyYW0gb2ZmZXJcclxuICogQHBhcmFtIGNhbGxiYWNrXHJcbiAqIEByZXR1cm5zIHtQZWVyfVxyXG4gKi9cclxuZnVuY3Rpb24gY3JlYXRlQW5zd2VyKG9mZmVyLCBjYWxsYmFjaykge1xyXG4gICAgdmFyIHBlZXIgPSBuZXcgUGVlcigpLCBwYyA9IHBlZXIucGM7XHJcbiAgICB2YXIgb2ZmZXJEZXNjID0gbmV3IFJUQ1Nlc3Npb25EZXNjcmlwdGlvbihKU09OLnBhcnNlKG9mZmVyKSk7XHJcbiAgICBwZWVyLmNyZWF0ZUNhbGxiYWNrID0gY2FsbGJhY2s7XHJcbiAgICBwYy5zZXRSZW1vdGVEZXNjcmlwdGlvbihvZmZlckRlc2MpO1xyXG4gICAgcGMuY3JlYXRlQW5zd2VyKGZ1bmN0aW9uIChhbnN3ZXJEZXNjKSB7XHJcbiAgICAgICAgcGMuc2V0TG9jYWxEZXNjcmlwdGlvbihhbnN3ZXJEZXNjKTtcclxuICAgIH0sIGZ1bmN0aW9uICgpIHsgY29uc29sZS53YXJuKFwiTm8gY3JlYXRlIGFuc3dlclwiKTsgfSk7XHJcblxyXG4gICAgcGMub25kYXRhY2hhbm5lbCA9IGZ1bmN0aW9uIChlKSB7XHJcbiAgICAgICAgdmFyIGRjID0gZS5jaGFubmVsIHx8IGU7IC8vIENocm9tZSBzZW5kcyBldmVudCwgRkYgc2VuZHMgcmF3IGNoYW5uZWxcclxuICAgICAgICBwZWVyLmRjID0gZGM7XHJcblxyXG4gICAgICAgIGRjLm9ub3BlbiA9IGZ1bmN0aW9uICgpIHtcclxuICAgICAgICAgICAgZGMuc2VuZChKU09OLnN0cmluZ2lmeSh7dHlwZTogTUVTU0FHRV9UWVBFLlRFTExfQUREUkVTUywgcGF5bG9hZDogQUREUkVTU30pKTtcclxuICAgICAgICAgICAgLy8gZGVsYXkgb3BlbiB1bnRpbCB0aGUgcmVzcG9uc2UgaXMgaW5cclxuICAgICAgICB9O1xyXG5cclxuICAgICAgICBkYy5vbm1lc3NhZ2UgPSBoYW5kbGVNZXNzYWdlKHBlZXIpO1xyXG4gICAgfTtcclxuXHJcbiAgICByZXR1cm4gcGVlcjtcclxufVxyXG5cclxuLyoqXHJcbiAqIEFwcGxpZXMgdGhlIHJlc3VsdFxyXG4gKiBAcGFyYW0gcGVlclxyXG4gKiBAcGFyYW0gYW5zd2VyXHJcbiAqL1xyXG5mdW5jdGlvbiBoYW5kbGVBbnN3ZXIocGVlciwgYW5zd2VyKSB7XHJcbiAgICB2YXIgYW5zd2VyRGVzYyA9IG5ldyBSVENTZXNzaW9uRGVzY3JpcHRpb24oSlNPTi5wYXJzZShhbnN3ZXIpKTtcclxuICAgIHBlZXIucGMuc2V0UmVtb3RlRGVzY3JpcHRpb24oYW5zd2VyRGVzYyk7XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBXZSBzb21laG93IG5lZWQgdG8gbm90aWZ5IEJvYiwgdGhhdCBBbGljZSBhdHRlbXB0cyB0byB0YWxrIHRvIGhpbSFcclxuICogQHBhcmFtIGNhbGxiYWNrIHtmdW5jdGlvbn0gKHtQZWVyfSlcclxuICovXHJcbmZ1bmN0aW9uIG9uUmVtb3RlQ29ubmVjdGlvbihjYWxsYmFjaykge1xyXG4gICAgb25SZW1vdGVDb25uZWN0aW9uQ2FsbGJhY2tzLnB1c2goY2FsbGJhY2spO1xyXG59O1xyXG5cclxuLyoqXHJcbiAqXHJcbiAqIEBwYXJhbSBjYWxsYmFjayB7ZnVuY3Rpb259IChQZWVyLCBPYmplY3QpXHJcbiAqL1xyXG5mdW5jdGlvbiBvbm1lc3NhZ2UoY2FsbGJhY2spIHtcclxuICAgIG9uTWVzc2FnZUNhbGxiYWNrcy5wdXNoKGNhbGxiYWNrKTtcclxufVxyXG5cclxuLyoqXHJcbiAqXHJcbiAqIEBwYXJhbSBhZGRyZXNzXHJcbiAqL1xyXG5mdW5jdGlvbiBnZXRQZWVyKGFkZHJlc3MpIHtcclxuICAgIHZhciBjdXJyZW50ID0gUGVlckNhY2hlLmdldChhZGRyZXNzKTtcclxuICAgIGlmIChjdXJyZW50KSB7XHJcbiAgICAgICAgcmV0dXJuIGN1cnJlbnQ7XHJcbiAgICB9IGVsc2Uge1xyXG4gICAgICAgIHJldHVybiBudWxsO1xyXG4gICAgfVxyXG59XHJcblxyXG4vKiA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT1cclxuIEVYUE9SVFxyXG4gPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09ICovXHJcbmV4cG9ydHMub25tZXNzYWdlID0gb25tZXNzYWdlO1xyXG5leHBvcnRzLmNyZWF0ZU9mZmVyID0gY3JlYXRlT2ZmZXI7XHJcbmV4cG9ydHMuaGFuZGxlQW5zd2VyID0gaGFuZGxlQW5zd2VyO1xyXG5leHBvcnRzLmNyZWF0ZUFuc3dlciA9IGNyZWF0ZUFuc3dlcjtcclxuZXhwb3J0cy5vblJlbW90ZUNvbm5lY3Rpb24gPSBvblJlbW90ZUNvbm5lY3Rpb247XHJcbmV4cG9ydHMuZ2V0UGVlciA9IGdldFBlZXI7XHJcbmV4cG9ydHMuYWRkcmVzcyA9IGZ1bmN0aW9uICgpIHtcclxuICAgIHJldHVybiBBRERSRVNTO1xyXG59OyIsIi8qKlxuICogVGhlIE1JVCBMaWNlbnNlIChNSVQpXG4gKiBcbiAqIENvcHlyaWdodCAoYykgMjAxNCBQZXRrYSBBbnRvbm92XG4gKiBcbiAqIFBlcm1pc3Npb24gaXMgaGVyZWJ5IGdyYW50ZWQsIGZyZWUgb2YgY2hhcmdlLCB0byBhbnkgcGVyc29uIG9idGFpbmluZyBhIGNvcHlcbiAqIG9mIHRoaXMgc29mdHdhcmUgYW5kIGFzc29jaWF0ZWQgZG9jdW1lbnRhdGlvbiBmaWxlcyAodGhlIFwiU29mdHdhcmVcIiksIHRvIGRlYWxcbiAqIGluIHRoZSBTb2Z0d2FyZSB3aXRob3V0IHJlc3RyaWN0aW9uLCBpbmNsdWRpbmcgd2l0aG91dCBsaW1pdGF0aW9uIHRoZSByaWdodHNcbiAqIHRvIHVzZSwgY29weSwgbW9kaWZ5LCBtZXJnZSwgcHVibGlzaCwgZGlzdHJpYnV0ZSwgc3VibGljZW5zZSwgYW5kL29yIHNlbGxcbiAqIGNvcGllcyBvZiB0aGUgU29mdHdhcmUsIGFuZCB0byBwZXJtaXQgcGVyc29ucyB0byB3aG9tIHRoZSBTb2Z0d2FyZSBpc1xuICogZnVybmlzaGVkIHRvIGRvIHNvLCBzdWJqZWN0IHRvIHRoZSBmb2xsb3dpbmcgY29uZGl0aW9uczo8L3A+XG4gKiBcbiAqIFRoZSBhYm92ZSBjb3B5cmlnaHQgbm90aWNlIGFuZCB0aGlzIHBlcm1pc3Npb24gbm90aWNlIHNoYWxsIGJlIGluY2x1ZGVkIGluXG4gKiBhbGwgY29waWVzIG9yIHN1YnN0YW50aWFsIHBvcnRpb25zIG9mIHRoZSBTb2Z0d2FyZS5cbiAqIFxuICogVEhFIFNPRlRXQVJFIElTIFBST1ZJREVEIFwiQVMgSVNcIiwgV0lUSE9VVCBXQVJSQU5UWSBPRiBBTlkgS0lORCwgRVhQUkVTUyBPUlxuICogSU1QTElFRCwgSU5DTFVESU5HIEJVVCBOT1QgTElNSVRFRCBUTyBUSEUgV0FSUkFOVElFUyBPRiBNRVJDSEFOVEFCSUxJVFksXG4gKiBGSVRORVNTIEZPUiBBIFBBUlRJQ1VMQVIgUFVSUE9TRSBBTkQgTk9OSU5GUklOR0VNRU5ULiAgSU4gTk8gRVZFTlQgU0hBTEwgVEhFXG4gKiBBVVRIT1JTIE9SIENPUFlSSUdIVCBIT0xERVJTIEJFIExJQUJMRSBGT1IgQU5ZIENMQUlNLCBEQU1BR0VTIE9SIE9USEVSXG4gKiBMSUFCSUxJVFksIFdIRVRIRVIgSU4gQU4gQUNUSU9OIE9GIENPTlRSQUNULCBUT1JUIE9SIE9USEVSV0lTRSwgQVJJU0lORyBGUk9NLFxuICogT1VUIE9GIE9SIElOIENPTk5FQ1RJT04gV0lUSCBUSEUgU09GVFdBUkUgT1IgVEhFIFVTRSBPUiBPVEhFUiBERUFMSU5HUyBJTlxuICogVEhFIFNPRlRXQVJFLlxuICogXG4gKi9cblwidXNlIHN0cmljdFwiO1xubW9kdWxlLmV4cG9ydHMgPSBmdW5jdGlvbihQcm9taXNlKSB7XG52YXIgU29tZVByb21pc2VBcnJheSA9IFByb21pc2UuX1NvbWVQcm9taXNlQXJyYXk7XG5mdW5jdGlvbiBQcm9taXNlJF9BbnkocHJvbWlzZXMpIHtcbiAgICB2YXIgcmV0ID0gbmV3IFNvbWVQcm9taXNlQXJyYXkocHJvbWlzZXMpO1xuICAgIHZhciBwcm9taXNlID0gcmV0LnByb21pc2UoKTtcbiAgICBpZiAocHJvbWlzZS5pc1JlamVjdGVkKCkpIHtcbiAgICAgICAgcmV0dXJuIHByb21pc2U7XG4gICAgfVxuICAgIHJldC5zZXRIb3dNYW55KDEpO1xuICAgIHJldC5zZXRVbndyYXAoKTtcbiAgICByZXQuaW5pdCgpO1xuICAgIHJldHVybiBwcm9taXNlO1xufVxuXG5Qcm9taXNlLmFueSA9IGZ1bmN0aW9uIFByb21pc2UkQW55KHByb21pc2VzKSB7XG4gICAgcmV0dXJuIFByb21pc2UkX0FueShwcm9taXNlcyk7XG59O1xuXG5Qcm9taXNlLnByb3RvdHlwZS5hbnkgPSBmdW5jdGlvbiBQcm9taXNlJGFueSgpIHtcbiAgICByZXR1cm4gUHJvbWlzZSRfQW55KHRoaXMpO1xufTtcblxufTtcbiIsIi8qKlxuICogVGhlIE1JVCBMaWNlbnNlIChNSVQpXG4gKiBcbiAqIENvcHlyaWdodCAoYykgMjAxNCBQZXRrYSBBbnRvbm92XG4gKiBcbiAqIFBlcm1pc3Npb24gaXMgaGVyZWJ5IGdyYW50ZWQsIGZyZWUgb2YgY2hhcmdlLCB0byBhbnkgcGVyc29uIG9idGFpbmluZyBhIGNvcHlcbiAqIG9mIHRoaXMgc29mdHdhcmUgYW5kIGFzc29jaWF0ZWQgZG9jdW1lbnRhdGlvbiBmaWxlcyAodGhlIFwiU29mdHdhcmVcIiksIHRvIGRlYWxcbiAqIGluIHRoZSBTb2Z0d2FyZSB3aXRob3V0IHJlc3RyaWN0aW9uLCBpbmNsdWRpbmcgd2l0aG91dCBsaW1pdGF0aW9uIHRoZSByaWdodHNcbiAqIHRvIHVzZSwgY29weSwgbW9kaWZ5LCBtZXJnZSwgcHVibGlzaCwgZGlzdHJpYnV0ZSwgc3VibGljZW5zZSwgYW5kL29yIHNlbGxcbiAqIGNvcGllcyBvZiB0aGUgU29mdHdhcmUsIGFuZCB0byBwZXJtaXQgcGVyc29ucyB0byB3aG9tIHRoZSBTb2Z0d2FyZSBpc1xuICogZnVybmlzaGVkIHRvIGRvIHNvLCBzdWJqZWN0IHRvIHRoZSBmb2xsb3dpbmcgY29uZGl0aW9uczo8L3A+XG4gKiBcbiAqIFRoZSBhYm92ZSBjb3B5cmlnaHQgbm90aWNlIGFuZCB0aGlzIHBlcm1pc3Npb24gbm90aWNlIHNoYWxsIGJlIGluY2x1ZGVkIGluXG4gKiBhbGwgY29waWVzIG9yIHN1YnN0YW50aWFsIHBvcnRpb25zIG9mIHRoZSBTb2Z0d2FyZS5cbiAqIFxuICogVEhFIFNPRlRXQVJFIElTIFBST1ZJREVEIFwiQVMgSVNcIiwgV0lUSE9VVCBXQVJSQU5UWSBPRiBBTlkgS0lORCwgRVhQUkVTUyBPUlxuICogSU1QTElFRCwgSU5DTFVESU5HIEJVVCBOT1QgTElNSVRFRCBUTyBUSEUgV0FSUkFOVElFUyBPRiBNRVJDSEFOVEFCSUxJVFksXG4gKiBGSVRORVNTIEZPUiBBIFBBUlRJQ1VMQVIgUFVSUE9TRSBBTkQgTk9OSU5GUklOR0VNRU5ULiAgSU4gTk8gRVZFTlQgU0hBTEwgVEhFXG4gKiBBVVRIT1JTIE9SIENPUFlSSUdIVCBIT0xERVJTIEJFIExJQUJMRSBGT1IgQU5ZIENMQUlNLCBEQU1BR0VTIE9SIE9USEVSXG4gKiBMSUFCSUxJVFksIFdIRVRIRVIgSU4gQU4gQUNUSU9OIE9GIENPTlRSQUNULCBUT1JUIE9SIE9USEVSV0lTRSwgQVJJU0lORyBGUk9NLFxuICogT1VUIE9GIE9SIElOIENPTk5FQ1RJT04gV0lUSCBUSEUgU09GVFdBUkUgT1IgVEhFIFVTRSBPUiBPVEhFUiBERUFMSU5HUyBJTlxuICogVEhFIFNPRlRXQVJFLlxuICogXG4gKi9cblwidXNlIHN0cmljdFwiO1xudmFyIHNjaGVkdWxlID0gcmVxdWlyZShcIi4vc2NoZWR1bGUuanNcIik7XG52YXIgUXVldWUgPSByZXF1aXJlKFwiLi9xdWV1ZS5qc1wiKTtcbnZhciBlcnJvck9iaiA9IHJlcXVpcmUoXCIuL3V0aWwuanNcIikuZXJyb3JPYmo7XG52YXIgdHJ5Q2F0Y2gxID0gcmVxdWlyZShcIi4vdXRpbC5qc1wiKS50cnlDYXRjaDE7XG52YXIgX3Byb2Nlc3MgPSB0eXBlb2YgcHJvY2VzcyAhPT0gXCJ1bmRlZmluZWRcIiA/IHByb2Nlc3MgOiB2b2lkIDA7XG5cbmZ1bmN0aW9uIEFzeW5jKCkge1xuICAgIHRoaXMuX2lzVGlja1VzZWQgPSBmYWxzZTtcbiAgICB0aGlzLl9zY2hlZHVsZSA9IHNjaGVkdWxlO1xuICAgIHRoaXMuX2xlbmd0aCA9IDA7XG4gICAgdGhpcy5fbGF0ZUJ1ZmZlciA9IG5ldyBRdWV1ZSgxNik7XG4gICAgdGhpcy5fZnVuY3Rpb25CdWZmZXIgPSBuZXcgUXVldWUoNjU1MzYpO1xuICAgIHZhciBzZWxmID0gdGhpcztcbiAgICB0aGlzLmNvbnN1bWVGdW5jdGlvbkJ1ZmZlciA9IGZ1bmN0aW9uIEFzeW5jJGNvbnN1bWVGdW5jdGlvbkJ1ZmZlcigpIHtcbiAgICAgICAgc2VsZi5fY29uc3VtZUZ1bmN0aW9uQnVmZmVyKCk7XG4gICAgfTtcbn1cblxuQXN5bmMucHJvdG90eXBlLmhhdmVJdGVtc1F1ZXVlZCA9IGZ1bmN0aW9uIEFzeW5jJGhhdmVJdGVtc1F1ZXVlZCgpIHtcbiAgICByZXR1cm4gdGhpcy5fbGVuZ3RoID4gMDtcbn07XG5cbkFzeW5jLnByb3RvdHlwZS5pbnZva2VMYXRlciA9IGZ1bmN0aW9uIEFzeW5jJGludm9rZUxhdGVyKGZuLCByZWNlaXZlciwgYXJnKSB7XG4gICAgaWYgKF9wcm9jZXNzICE9PSB2b2lkIDAgJiZcbiAgICAgICAgX3Byb2Nlc3MuZG9tYWluICE9IG51bGwgJiZcbiAgICAgICAgIWZuLmRvbWFpbikge1xuICAgICAgICBmbiA9IF9wcm9jZXNzLmRvbWFpbi5iaW5kKGZuKTtcbiAgICB9XG4gICAgdGhpcy5fbGF0ZUJ1ZmZlci5wdXNoKGZuLCByZWNlaXZlciwgYXJnKTtcbiAgICB0aGlzLl9xdWV1ZVRpY2soKTtcbn07XG5cbkFzeW5jLnByb3RvdHlwZS5pbnZva2UgPSBmdW5jdGlvbiBBc3luYyRpbnZva2UoZm4sIHJlY2VpdmVyLCBhcmcpIHtcbiAgICBpZiAoX3Byb2Nlc3MgIT09IHZvaWQgMCAmJlxuICAgICAgICBfcHJvY2Vzcy5kb21haW4gIT0gbnVsbCAmJlxuICAgICAgICAhZm4uZG9tYWluKSB7XG4gICAgICAgIGZuID0gX3Byb2Nlc3MuZG9tYWluLmJpbmQoZm4pO1xuICAgIH1cbiAgICB2YXIgZnVuY3Rpb25CdWZmZXIgPSB0aGlzLl9mdW5jdGlvbkJ1ZmZlcjtcbiAgICBmdW5jdGlvbkJ1ZmZlci5wdXNoKGZuLCByZWNlaXZlciwgYXJnKTtcbiAgICB0aGlzLl9sZW5ndGggPSBmdW5jdGlvbkJ1ZmZlci5sZW5ndGgoKTtcbiAgICB0aGlzLl9xdWV1ZVRpY2soKTtcbn07XG5cbkFzeW5jLnByb3RvdHlwZS5fY29uc3VtZUZ1bmN0aW9uQnVmZmVyID1cbmZ1bmN0aW9uIEFzeW5jJF9jb25zdW1lRnVuY3Rpb25CdWZmZXIoKSB7XG4gICAgdmFyIGZ1bmN0aW9uQnVmZmVyID0gdGhpcy5fZnVuY3Rpb25CdWZmZXI7XG4gICAgd2hpbGUgKGZ1bmN0aW9uQnVmZmVyLmxlbmd0aCgpID4gMCkge1xuICAgICAgICB2YXIgZm4gPSBmdW5jdGlvbkJ1ZmZlci5zaGlmdCgpO1xuICAgICAgICB2YXIgcmVjZWl2ZXIgPSBmdW5jdGlvbkJ1ZmZlci5zaGlmdCgpO1xuICAgICAgICB2YXIgYXJnID0gZnVuY3Rpb25CdWZmZXIuc2hpZnQoKTtcbiAgICAgICAgZm4uY2FsbChyZWNlaXZlciwgYXJnKTtcbiAgICB9XG4gICAgdGhpcy5fcmVzZXQoKTtcbiAgICB0aGlzLl9jb25zdW1lTGF0ZUJ1ZmZlcigpO1xufTtcblxuQXN5bmMucHJvdG90eXBlLl9jb25zdW1lTGF0ZUJ1ZmZlciA9IGZ1bmN0aW9uIEFzeW5jJF9jb25zdW1lTGF0ZUJ1ZmZlcigpIHtcbiAgICB2YXIgYnVmZmVyID0gdGhpcy5fbGF0ZUJ1ZmZlcjtcbiAgICB3aGlsZShidWZmZXIubGVuZ3RoKCkgPiAwKSB7XG4gICAgICAgIHZhciBmbiA9IGJ1ZmZlci5zaGlmdCgpO1xuICAgICAgICB2YXIgcmVjZWl2ZXIgPSBidWZmZXIuc2hpZnQoKTtcbiAgICAgICAgdmFyIGFyZyA9IGJ1ZmZlci5zaGlmdCgpO1xuICAgICAgICB2YXIgcmVzID0gdHJ5Q2F0Y2gxKGZuLCByZWNlaXZlciwgYXJnKTtcbiAgICAgICAgaWYgKHJlcyA9PT0gZXJyb3JPYmopIHtcbiAgICAgICAgICAgIHRoaXMuX3F1ZXVlVGljaygpO1xuICAgICAgICAgICAgaWYgKGZuLmRvbWFpbiAhPSBudWxsKSB7XG4gICAgICAgICAgICAgICAgZm4uZG9tYWluLmVtaXQoXCJlcnJvclwiLCByZXMuZSk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHRocm93IHJlcy5lO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgfVxufTtcblxuQXN5bmMucHJvdG90eXBlLl9xdWV1ZVRpY2sgPSBmdW5jdGlvbiBBc3luYyRfcXVldWUoKSB7XG4gICAgaWYgKCF0aGlzLl9pc1RpY2tVc2VkKSB7XG4gICAgICAgIHRoaXMuX3NjaGVkdWxlKHRoaXMuY29uc3VtZUZ1bmN0aW9uQnVmZmVyKTtcbiAgICAgICAgdGhpcy5faXNUaWNrVXNlZCA9IHRydWU7XG4gICAgfVxufTtcblxuQXN5bmMucHJvdG90eXBlLl9yZXNldCA9IGZ1bmN0aW9uIEFzeW5jJF9yZXNldCgpIHtcbiAgICB0aGlzLl9pc1RpY2tVc2VkID0gZmFsc2U7XG4gICAgdGhpcy5fbGVuZ3RoID0gMDtcbn07XG5cbm1vZHVsZS5leHBvcnRzID0gbmV3IEFzeW5jKCk7XG4iLCIvKipcbiAqIFRoZSBNSVQgTGljZW5zZSAoTUlUKVxuICogXG4gKiBDb3B5cmlnaHQgKGMpIDIwMTQgUGV0a2EgQW50b25vdlxuICogXG4gKiBQZXJtaXNzaW9uIGlzIGhlcmVieSBncmFudGVkLCBmcmVlIG9mIGNoYXJnZSwgdG8gYW55IHBlcnNvbiBvYnRhaW5pbmcgYSBjb3B5XG4gKiBvZiB0aGlzIHNvZnR3YXJlIGFuZCBhc3NvY2lhdGVkIGRvY3VtZW50YXRpb24gZmlsZXMgKHRoZSBcIlNvZnR3YXJlXCIpLCB0byBkZWFsXG4gKiBpbiB0aGUgU29mdHdhcmUgd2l0aG91dCByZXN0cmljdGlvbiwgaW5jbHVkaW5nIHdpdGhvdXQgbGltaXRhdGlvbiB0aGUgcmlnaHRzXG4gKiB0byB1c2UsIGNvcHksIG1vZGlmeSwgbWVyZ2UsIHB1Ymxpc2gsIGRpc3RyaWJ1dGUsIHN1YmxpY2Vuc2UsIGFuZC9vciBzZWxsXG4gKiBjb3BpZXMgb2YgdGhlIFNvZnR3YXJlLCBhbmQgdG8gcGVybWl0IHBlcnNvbnMgdG8gd2hvbSB0aGUgU29mdHdhcmUgaXNcbiAqIGZ1cm5pc2hlZCB0byBkbyBzbywgc3ViamVjdCB0byB0aGUgZm9sbG93aW5nIGNvbmRpdGlvbnM6PC9wPlxuICogXG4gKiBUaGUgYWJvdmUgY29weXJpZ2h0IG5vdGljZSBhbmQgdGhpcyBwZXJtaXNzaW9uIG5vdGljZSBzaGFsbCBiZSBpbmNsdWRlZCBpblxuICogYWxsIGNvcGllcyBvciBzdWJzdGFudGlhbCBwb3J0aW9ucyBvZiB0aGUgU29mdHdhcmUuXG4gKiBcbiAqIFRIRSBTT0ZUV0FSRSBJUyBQUk9WSURFRCBcIkFTIElTXCIsIFdJVEhPVVQgV0FSUkFOVFkgT0YgQU5ZIEtJTkQsIEVYUFJFU1MgT1JcbiAqIElNUExJRUQsIElOQ0xVRElORyBCVVQgTk9UIExJTUlURUQgVE8gVEhFIFdBUlJBTlRJRVMgT0YgTUVSQ0hBTlRBQklMSVRZLFxuICogRklUTkVTUyBGT1IgQSBQQVJUSUNVTEFSIFBVUlBPU0UgQU5EIE5PTklORlJJTkdFTUVOVC4gIElOIE5PIEVWRU5UIFNIQUxMIFRIRVxuICogQVVUSE9SUyBPUiBDT1BZUklHSFQgSE9MREVSUyBCRSBMSUFCTEUgRk9SIEFOWSBDTEFJTSwgREFNQUdFUyBPUiBPVEhFUlxuICogTElBQklMSVRZLCBXSEVUSEVSIElOIEFOIEFDVElPTiBPRiBDT05UUkFDVCwgVE9SVCBPUiBPVEhFUldJU0UsIEFSSVNJTkcgRlJPTSxcbiAqIE9VVCBPRiBPUiBJTiBDT05ORUNUSU9OIFdJVEggVEhFIFNPRlRXQVJFIE9SIFRIRSBVU0UgT1IgT1RIRVIgREVBTElOR1MgSU5cbiAqIFRIRSBTT0ZUV0FSRS5cbiAqIFxuICovXG5cInVzZSBzdHJpY3RcIjtcbnZhciBQcm9taXNlID0gcmVxdWlyZShcIi4vcHJvbWlzZS5qc1wiKSgpO1xubW9kdWxlLmV4cG9ydHMgPSBQcm9taXNlOyIsIi8qKlxuICogVGhlIE1JVCBMaWNlbnNlIChNSVQpXG4gKiBcbiAqIENvcHlyaWdodCAoYykgMjAxNCBQZXRrYSBBbnRvbm92XG4gKiBcbiAqIFBlcm1pc3Npb24gaXMgaGVyZWJ5IGdyYW50ZWQsIGZyZWUgb2YgY2hhcmdlLCB0byBhbnkgcGVyc29uIG9idGFpbmluZyBhIGNvcHlcbiAqIG9mIHRoaXMgc29mdHdhcmUgYW5kIGFzc29jaWF0ZWQgZG9jdW1lbnRhdGlvbiBmaWxlcyAodGhlIFwiU29mdHdhcmVcIiksIHRvIGRlYWxcbiAqIGluIHRoZSBTb2Z0d2FyZSB3aXRob3V0IHJlc3RyaWN0aW9uLCBpbmNsdWRpbmcgd2l0aG91dCBsaW1pdGF0aW9uIHRoZSByaWdodHNcbiAqIHRvIHVzZSwgY29weSwgbW9kaWZ5LCBtZXJnZSwgcHVibGlzaCwgZGlzdHJpYnV0ZSwgc3VibGljZW5zZSwgYW5kL29yIHNlbGxcbiAqIGNvcGllcyBvZiB0aGUgU29mdHdhcmUsIGFuZCB0byBwZXJtaXQgcGVyc29ucyB0byB3aG9tIHRoZSBTb2Z0d2FyZSBpc1xuICogZnVybmlzaGVkIHRvIGRvIHNvLCBzdWJqZWN0IHRvIHRoZSBmb2xsb3dpbmcgY29uZGl0aW9uczo8L3A+XG4gKiBcbiAqIFRoZSBhYm92ZSBjb3B5cmlnaHQgbm90aWNlIGFuZCB0aGlzIHBlcm1pc3Npb24gbm90aWNlIHNoYWxsIGJlIGluY2x1ZGVkIGluXG4gKiBhbGwgY29waWVzIG9yIHN1YnN0YW50aWFsIHBvcnRpb25zIG9mIHRoZSBTb2Z0d2FyZS5cbiAqIFxuICogVEhFIFNPRlRXQVJFIElTIFBST1ZJREVEIFwiQVMgSVNcIiwgV0lUSE9VVCBXQVJSQU5UWSBPRiBBTlkgS0lORCwgRVhQUkVTUyBPUlxuICogSU1QTElFRCwgSU5DTFVESU5HIEJVVCBOT1QgTElNSVRFRCBUTyBUSEUgV0FSUkFOVElFUyBPRiBNRVJDSEFOVEFCSUxJVFksXG4gKiBGSVRORVNTIEZPUiBBIFBBUlRJQ1VMQVIgUFVSUE9TRSBBTkQgTk9OSU5GUklOR0VNRU5ULiAgSU4gTk8gRVZFTlQgU0hBTEwgVEhFXG4gKiBBVVRIT1JTIE9SIENPUFlSSUdIVCBIT0xERVJTIEJFIExJQUJMRSBGT1IgQU5ZIENMQUlNLCBEQU1BR0VTIE9SIE9USEVSXG4gKiBMSUFCSUxJVFksIFdIRVRIRVIgSU4gQU4gQUNUSU9OIE9GIENPTlRSQUNULCBUT1JUIE9SIE9USEVSV0lTRSwgQVJJU0lORyBGUk9NLFxuICogT1VUIE9GIE9SIElOIENPTk5FQ1RJT04gV0lUSCBUSEUgU09GVFdBUkUgT1IgVEhFIFVTRSBPUiBPVEhFUiBERUFMSU5HUyBJTlxuICogVEhFIFNPRlRXQVJFLlxuICogXG4gKi9cblwidXNlIHN0cmljdFwiO1xudmFyIGNyID0gT2JqZWN0LmNyZWF0ZTtcbmlmIChjcikge1xuICAgIHZhciBjYWxsZXJDYWNoZSA9IGNyKG51bGwpO1xuICAgIHZhciBnZXR0ZXJDYWNoZSA9IGNyKG51bGwpO1xuICAgIGNhbGxlckNhY2hlW1wiIHNpemVcIl0gPSBnZXR0ZXJDYWNoZVtcIiBzaXplXCJdID0gMDtcbn1cblxubW9kdWxlLmV4cG9ydHMgPSBmdW5jdGlvbihQcm9taXNlKSB7XG52YXIgdXRpbCA9IHJlcXVpcmUoXCIuL3V0aWwuanNcIik7XG52YXIgY2FuRXZhbHVhdGUgPSB1dGlsLmNhbkV2YWx1YXRlO1xudmFyIGlzSWRlbnRpZmllciA9IHV0aWwuaXNJZGVudGlmaWVyO1xuXG5mdW5jdGlvbiBtYWtlTWV0aG9kQ2FsbGVyIChtZXRob2ROYW1lKSB7XG4gICAgcmV0dXJuIG5ldyBGdW5jdGlvbihcIm9ialwiLCBcIiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxcblxcXG4gICAgICAgICd1c2Ugc3RyaWN0JyAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxcblxcXG4gICAgICAgIHZhciBsZW4gPSB0aGlzLmxlbmd0aDsgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxcblxcXG4gICAgICAgIHN3aXRjaChsZW4pIHsgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxcblxcXG4gICAgICAgICAgICBjYXNlIDE6IHJldHVybiBvYmoubWV0aG9kTmFtZSh0aGlzWzBdKTsgICAgICAgICAgICAgICAgICAgICAgICAgIFxcblxcXG4gICAgICAgICAgICBjYXNlIDI6IHJldHVybiBvYmoubWV0aG9kTmFtZSh0aGlzWzBdLCB0aGlzWzFdKTsgICAgICAgICAgICAgICAgIFxcblxcXG4gICAgICAgICAgICBjYXNlIDM6IHJldHVybiBvYmoubWV0aG9kTmFtZSh0aGlzWzBdLCB0aGlzWzFdLCB0aGlzWzJdKTsgICAgICAgIFxcblxcXG4gICAgICAgICAgICBjYXNlIDA6IHJldHVybiBvYmoubWV0aG9kTmFtZSgpOyAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxcblxcXG4gICAgICAgICAgICBkZWZhdWx0OiByZXR1cm4gb2JqLm1ldGhvZE5hbWUuYXBwbHkob2JqLCB0aGlzKTsgICAgICAgICAgICAgICAgIFxcblxcXG4gICAgICAgIH0gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxcblxcXG4gICAgICAgIFwiLnJlcGxhY2UoL21ldGhvZE5hbWUvZywgbWV0aG9kTmFtZSkpO1xufVxuXG5mdW5jdGlvbiBtYWtlR2V0dGVyIChwcm9wZXJ0eU5hbWUpIHtcbiAgICByZXR1cm4gbmV3IEZ1bmN0aW9uKFwib2JqXCIsIFwiICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXFxuXFxcbiAgICAgICAgJ3VzZSBzdHJpY3QnOyAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXFxuXFxcbiAgICAgICAgcmV0dXJuIG9iai5wcm9wZXJ0eU5hbWU7ICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXFxuXFxcbiAgICAgICAgXCIucmVwbGFjZShcInByb3BlcnR5TmFtZVwiLCBwcm9wZXJ0eU5hbWUpKTtcbn1cblxuZnVuY3Rpb24gZ2V0Q29tcGlsZWQobmFtZSwgY29tcGlsZXIsIGNhY2hlKSB7XG4gICAgdmFyIHJldCA9IGNhY2hlW25hbWVdO1xuICAgIGlmICh0eXBlb2YgcmV0ICE9PSBcImZ1bmN0aW9uXCIpIHtcbiAgICAgICAgaWYgKCFpc0lkZW50aWZpZXIobmFtZSkpIHtcbiAgICAgICAgICAgIHJldHVybiBudWxsO1xuICAgICAgICB9XG4gICAgICAgIHJldCA9IGNvbXBpbGVyKG5hbWUpO1xuICAgICAgICBjYWNoZVtuYW1lXSA9IHJldDtcbiAgICAgICAgY2FjaGVbXCIgc2l6ZVwiXSsrO1xuICAgICAgICBpZiAoY2FjaGVbXCIgc2l6ZVwiXSA+IDUxMikge1xuICAgICAgICAgICAgdmFyIGtleXMgPSBPYmplY3Qua2V5cyhjYWNoZSk7XG4gICAgICAgICAgICBmb3IgKHZhciBpID0gMDsgaSA8IDI1NjsgKytpKSBkZWxldGUgY2FjaGVba2V5c1tpXV07XG4gICAgICAgICAgICBjYWNoZVtcIiBzaXplXCJdID0ga2V5cy5sZW5ndGggLSAyNTY7XG4gICAgICAgIH1cbiAgICB9XG4gICAgcmV0dXJuIHJldDtcbn1cblxuZnVuY3Rpb24gZ2V0TWV0aG9kQ2FsbGVyKG5hbWUpIHtcbiAgICByZXR1cm4gZ2V0Q29tcGlsZWQobmFtZSwgbWFrZU1ldGhvZENhbGxlciwgY2FsbGVyQ2FjaGUpO1xufVxuXG5mdW5jdGlvbiBnZXRHZXR0ZXIobmFtZSkge1xuICAgIHJldHVybiBnZXRDb21waWxlZChuYW1lLCBtYWtlR2V0dGVyLCBnZXR0ZXJDYWNoZSk7XG59XG5cbmZ1bmN0aW9uIGNhbGxlcihvYmopIHtcbiAgICByZXR1cm4gb2JqW3RoaXMucG9wKCldLmFwcGx5KG9iaiwgdGhpcyk7XG59XG5Qcm9taXNlLnByb3RvdHlwZS5jYWxsID0gZnVuY3Rpb24gUHJvbWlzZSRjYWxsKG1ldGhvZE5hbWUpIHtcbiAgICB2YXIgJF9sZW4gPSBhcmd1bWVudHMubGVuZ3RoO3ZhciBhcmdzID0gbmV3IEFycmF5KCRfbGVuIC0gMSk7IGZvcih2YXIgJF9pID0gMTsgJF9pIDwgJF9sZW47ICsrJF9pKSB7YXJnc1skX2kgLSAxXSA9IGFyZ3VtZW50c1skX2ldO31cbiAgICBpZiAoY2FuRXZhbHVhdGUpIHtcbiAgICAgICAgdmFyIG1heWJlQ2FsbGVyID0gZ2V0TWV0aG9kQ2FsbGVyKG1ldGhvZE5hbWUpO1xuICAgICAgICBpZiAobWF5YmVDYWxsZXIgIT09IG51bGwpIHtcbiAgICAgICAgICAgIHJldHVybiB0aGlzLl90aGVuKG1heWJlQ2FsbGVyLCB2b2lkIDAsIHZvaWQgMCwgYXJncywgdm9pZCAwKTtcbiAgICAgICAgfVxuICAgIH1cbiAgICBhcmdzLnB1c2gobWV0aG9kTmFtZSk7XG4gICAgcmV0dXJuIHRoaXMuX3RoZW4oY2FsbGVyLCB2b2lkIDAsIHZvaWQgMCwgYXJncywgdm9pZCAwKTtcbn07XG5cbmZ1bmN0aW9uIG5hbWVkR2V0dGVyKG9iaikge1xuICAgIHJldHVybiBvYmpbdGhpc107XG59XG5mdW5jdGlvbiBpbmRleGVkR2V0dGVyKG9iaikge1xuICAgIHJldHVybiBvYmpbdGhpc107XG59XG5Qcm9taXNlLnByb3RvdHlwZS5nZXQgPSBmdW5jdGlvbiBQcm9taXNlJGdldChwcm9wZXJ0eU5hbWUpIHtcbiAgICB2YXIgaXNJbmRleCA9ICh0eXBlb2YgcHJvcGVydHlOYW1lID09PSBcIm51bWJlclwiKTtcbiAgICB2YXIgZ2V0dGVyO1xuICAgIGlmICghaXNJbmRleCkge1xuICAgICAgICBpZiAoY2FuRXZhbHVhdGUpIHtcbiAgICAgICAgICAgIHZhciBtYXliZUdldHRlciA9IGdldEdldHRlcihwcm9wZXJ0eU5hbWUpO1xuICAgICAgICAgICAgZ2V0dGVyID0gbWF5YmVHZXR0ZXIgIT09IG51bGwgPyBtYXliZUdldHRlciA6IG5hbWVkR2V0dGVyO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgZ2V0dGVyID0gbmFtZWRHZXR0ZXI7XG4gICAgICAgIH1cbiAgICB9IGVsc2Uge1xuICAgICAgICBnZXR0ZXIgPSBpbmRleGVkR2V0dGVyO1xuICAgIH1cbiAgICByZXR1cm4gdGhpcy5fdGhlbihnZXR0ZXIsIHZvaWQgMCwgdm9pZCAwLCBwcm9wZXJ0eU5hbWUsIHZvaWQgMCk7XG59O1xufTtcbiIsIi8qKlxuICogVGhlIE1JVCBMaWNlbnNlIChNSVQpXG4gKiBcbiAqIENvcHlyaWdodCAoYykgMjAxNCBQZXRrYSBBbnRvbm92XG4gKiBcbiAqIFBlcm1pc3Npb24gaXMgaGVyZWJ5IGdyYW50ZWQsIGZyZWUgb2YgY2hhcmdlLCB0byBhbnkgcGVyc29uIG9idGFpbmluZyBhIGNvcHlcbiAqIG9mIHRoaXMgc29mdHdhcmUgYW5kIGFzc29jaWF0ZWQgZG9jdW1lbnRhdGlvbiBmaWxlcyAodGhlIFwiU29mdHdhcmVcIiksIHRvIGRlYWxcbiAqIGluIHRoZSBTb2Z0d2FyZSB3aXRob3V0IHJlc3RyaWN0aW9uLCBpbmNsdWRpbmcgd2l0aG91dCBsaW1pdGF0aW9uIHRoZSByaWdodHNcbiAqIHRvIHVzZSwgY29weSwgbW9kaWZ5LCBtZXJnZSwgcHVibGlzaCwgZGlzdHJpYnV0ZSwgc3VibGljZW5zZSwgYW5kL29yIHNlbGxcbiAqIGNvcGllcyBvZiB0aGUgU29mdHdhcmUsIGFuZCB0byBwZXJtaXQgcGVyc29ucyB0byB3aG9tIHRoZSBTb2Z0d2FyZSBpc1xuICogZnVybmlzaGVkIHRvIGRvIHNvLCBzdWJqZWN0IHRvIHRoZSBmb2xsb3dpbmcgY29uZGl0aW9uczo8L3A+XG4gKiBcbiAqIFRoZSBhYm92ZSBjb3B5cmlnaHQgbm90aWNlIGFuZCB0aGlzIHBlcm1pc3Npb24gbm90aWNlIHNoYWxsIGJlIGluY2x1ZGVkIGluXG4gKiBhbGwgY29waWVzIG9yIHN1YnN0YW50aWFsIHBvcnRpb25zIG9mIHRoZSBTb2Z0d2FyZS5cbiAqIFxuICogVEhFIFNPRlRXQVJFIElTIFBST1ZJREVEIFwiQVMgSVNcIiwgV0lUSE9VVCBXQVJSQU5UWSBPRiBBTlkgS0lORCwgRVhQUkVTUyBPUlxuICogSU1QTElFRCwgSU5DTFVESU5HIEJVVCBOT1QgTElNSVRFRCBUTyBUSEUgV0FSUkFOVElFUyBPRiBNRVJDSEFOVEFCSUxJVFksXG4gKiBGSVRORVNTIEZPUiBBIFBBUlRJQ1VMQVIgUFVSUE9TRSBBTkQgTk9OSU5GUklOR0VNRU5ULiAgSU4gTk8gRVZFTlQgU0hBTEwgVEhFXG4gKiBBVVRIT1JTIE9SIENPUFlSSUdIVCBIT0xERVJTIEJFIExJQUJMRSBGT1IgQU5ZIENMQUlNLCBEQU1BR0VTIE9SIE9USEVSXG4gKiBMSUFCSUxJVFksIFdIRVRIRVIgSU4gQU4gQUNUSU9OIE9GIENPTlRSQUNULCBUT1JUIE9SIE9USEVSV0lTRSwgQVJJU0lORyBGUk9NLFxuICogT1VUIE9GIE9SIElOIENPTk5FQ1RJT04gV0lUSCBUSEUgU09GVFdBUkUgT1IgVEhFIFVTRSBPUiBPVEhFUiBERUFMSU5HUyBJTlxuICogVEhFIFNPRlRXQVJFLlxuICogXG4gKi9cblwidXNlIHN0cmljdFwiO1xubW9kdWxlLmV4cG9ydHMgPSBmdW5jdGlvbihQcm9taXNlLCBJTlRFUk5BTCkge1xudmFyIGVycm9ycyA9IHJlcXVpcmUoXCIuL2Vycm9ycy5qc1wiKTtcbnZhciBjYW5BdHRhY2ggPSBlcnJvcnMuY2FuQXR0YWNoO1xudmFyIGFzeW5jID0gcmVxdWlyZShcIi4vYXN5bmMuanNcIik7XG52YXIgQ2FuY2VsbGF0aW9uRXJyb3IgPSBlcnJvcnMuQ2FuY2VsbGF0aW9uRXJyb3I7XG5cblByb21pc2UucHJvdG90eXBlLl9jYW5jZWwgPSBmdW5jdGlvbiBQcm9taXNlJF9jYW5jZWwocmVhc29uKSB7XG4gICAgaWYgKCF0aGlzLmlzQ2FuY2VsbGFibGUoKSkgcmV0dXJuIHRoaXM7XG4gICAgdmFyIHBhcmVudDtcbiAgICB2YXIgcHJvbWlzZVRvUmVqZWN0ID0gdGhpcztcbiAgICB3aGlsZSAoKHBhcmVudCA9IHByb21pc2VUb1JlamVjdC5fY2FuY2VsbGF0aW9uUGFyZW50KSAhPT0gdm9pZCAwICYmXG4gICAgICAgIHBhcmVudC5pc0NhbmNlbGxhYmxlKCkpIHtcbiAgICAgICAgcHJvbWlzZVRvUmVqZWN0ID0gcGFyZW50O1xuICAgIH1cbiAgICB0aGlzLl91bnNldENhbmNlbGxhYmxlKCk7XG4gICAgcHJvbWlzZVRvUmVqZWN0Ll9hdHRhY2hFeHRyYVRyYWNlKHJlYXNvbik7XG4gICAgcHJvbWlzZVRvUmVqZWN0Ll9yZWplY3RVbmNoZWNrZWQocmVhc29uKTtcbn07XG5cblByb21pc2UucHJvdG90eXBlLmNhbmNlbCA9IGZ1bmN0aW9uIFByb21pc2UkY2FuY2VsKHJlYXNvbikge1xuICAgIGlmICghdGhpcy5pc0NhbmNlbGxhYmxlKCkpIHJldHVybiB0aGlzO1xuICAgIHJlYXNvbiA9IHJlYXNvbiAhPT0gdm9pZCAwXG4gICAgICAgID8gKGNhbkF0dGFjaChyZWFzb24pID8gcmVhc29uIDogbmV3IEVycm9yKHJlYXNvbiArIFwiXCIpKVxuICAgICAgICA6IG5ldyBDYW5jZWxsYXRpb25FcnJvcigpO1xuICAgIGFzeW5jLmludm9rZUxhdGVyKHRoaXMuX2NhbmNlbCwgdGhpcywgcmVhc29uKTtcbiAgICByZXR1cm4gdGhpcztcbn07XG5cblByb21pc2UucHJvdG90eXBlLmNhbmNlbGxhYmxlID0gZnVuY3Rpb24gUHJvbWlzZSRjYW5jZWxsYWJsZSgpIHtcbiAgICBpZiAodGhpcy5fY2FuY2VsbGFibGUoKSkgcmV0dXJuIHRoaXM7XG4gICAgdGhpcy5fc2V0Q2FuY2VsbGFibGUoKTtcbiAgICB0aGlzLl9jYW5jZWxsYXRpb25QYXJlbnQgPSB2b2lkIDA7XG4gICAgcmV0dXJuIHRoaXM7XG59O1xuXG5Qcm9taXNlLnByb3RvdHlwZS51bmNhbmNlbGxhYmxlID0gZnVuY3Rpb24gUHJvbWlzZSR1bmNhbmNlbGxhYmxlKCkge1xuICAgIHZhciByZXQgPSBuZXcgUHJvbWlzZShJTlRFUk5BTCk7XG4gICAgcmV0Ll9wcm9wYWdhdGVGcm9tKHRoaXMsIDIgfCA0KTtcbiAgICByZXQuX2ZvbGxvdyh0aGlzKTtcbiAgICByZXQuX3Vuc2V0Q2FuY2VsbGFibGUoKTtcbiAgICByZXR1cm4gcmV0O1xufTtcblxuUHJvbWlzZS5wcm90b3R5cGUuZm9yayA9XG5mdW5jdGlvbiBQcm9taXNlJGZvcmsoZGlkRnVsZmlsbCwgZGlkUmVqZWN0LCBkaWRQcm9ncmVzcykge1xuICAgIHZhciByZXQgPSB0aGlzLl90aGVuKGRpZEZ1bGZpbGwsIGRpZFJlamVjdCwgZGlkUHJvZ3Jlc3MsXG4gICAgICAgICAgICAgICAgICAgICAgICAgdm9pZCAwLCB2b2lkIDApO1xuXG4gICAgcmV0Ll9zZXRDYW5jZWxsYWJsZSgpO1xuICAgIHJldC5fY2FuY2VsbGF0aW9uUGFyZW50ID0gdm9pZCAwO1xuICAgIHJldHVybiByZXQ7XG59O1xufTtcbiIsIi8qKlxuICogVGhlIE1JVCBMaWNlbnNlIChNSVQpXG4gKiBcbiAqIENvcHlyaWdodCAoYykgMjAxNCBQZXRrYSBBbnRvbm92XG4gKiBcbiAqIFBlcm1pc3Npb24gaXMgaGVyZWJ5IGdyYW50ZWQsIGZyZWUgb2YgY2hhcmdlLCB0byBhbnkgcGVyc29uIG9idGFpbmluZyBhIGNvcHlcbiAqIG9mIHRoaXMgc29mdHdhcmUgYW5kIGFzc29jaWF0ZWQgZG9jdW1lbnRhdGlvbiBmaWxlcyAodGhlIFwiU29mdHdhcmVcIiksIHRvIGRlYWxcbiAqIGluIHRoZSBTb2Z0d2FyZSB3aXRob3V0IHJlc3RyaWN0aW9uLCBpbmNsdWRpbmcgd2l0aG91dCBsaW1pdGF0aW9uIHRoZSByaWdodHNcbiAqIHRvIHVzZSwgY29weSwgbW9kaWZ5LCBtZXJnZSwgcHVibGlzaCwgZGlzdHJpYnV0ZSwgc3VibGljZW5zZSwgYW5kL29yIHNlbGxcbiAqIGNvcGllcyBvZiB0aGUgU29mdHdhcmUsIGFuZCB0byBwZXJtaXQgcGVyc29ucyB0byB3aG9tIHRoZSBTb2Z0d2FyZSBpc1xuICogZnVybmlzaGVkIHRvIGRvIHNvLCBzdWJqZWN0IHRvIHRoZSBmb2xsb3dpbmcgY29uZGl0aW9uczo8L3A+XG4gKiBcbiAqIFRoZSBhYm92ZSBjb3B5cmlnaHQgbm90aWNlIGFuZCB0aGlzIHBlcm1pc3Npb24gbm90aWNlIHNoYWxsIGJlIGluY2x1ZGVkIGluXG4gKiBhbGwgY29waWVzIG9yIHN1YnN0YW50aWFsIHBvcnRpb25zIG9mIHRoZSBTb2Z0d2FyZS5cbiAqIFxuICogVEhFIFNPRlRXQVJFIElTIFBST1ZJREVEIFwiQVMgSVNcIiwgV0lUSE9VVCBXQVJSQU5UWSBPRiBBTlkgS0lORCwgRVhQUkVTUyBPUlxuICogSU1QTElFRCwgSU5DTFVESU5HIEJVVCBOT1QgTElNSVRFRCBUTyBUSEUgV0FSUkFOVElFUyBPRiBNRVJDSEFOVEFCSUxJVFksXG4gKiBGSVRORVNTIEZPUiBBIFBBUlRJQ1VMQVIgUFVSUE9TRSBBTkQgTk9OSU5GUklOR0VNRU5ULiAgSU4gTk8gRVZFTlQgU0hBTEwgVEhFXG4gKiBBVVRIT1JTIE9SIENPUFlSSUdIVCBIT0xERVJTIEJFIExJQUJMRSBGT1IgQU5ZIENMQUlNLCBEQU1BR0VTIE9SIE9USEVSXG4gKiBMSUFCSUxJVFksIFdIRVRIRVIgSU4gQU4gQUNUSU9OIE9GIENPTlRSQUNULCBUT1JUIE9SIE9USEVSV0lTRSwgQVJJU0lORyBGUk9NLFxuICogT1VUIE9GIE9SIElOIENPTk5FQ1RJT04gV0lUSCBUSEUgU09GVFdBUkUgT1IgVEhFIFVTRSBPUiBPVEhFUiBERUFMSU5HUyBJTlxuICogVEhFIFNPRlRXQVJFLlxuICogXG4gKi9cblwidXNlIHN0cmljdFwiO1xubW9kdWxlLmV4cG9ydHMgPSBmdW5jdGlvbigpIHtcbnZhciBpbmhlcml0cyA9IHJlcXVpcmUoXCIuL3V0aWwuanNcIikuaW5oZXJpdHM7XG52YXIgZGVmaW5lUHJvcGVydHkgPSByZXF1aXJlKFwiLi9lczUuanNcIikuZGVmaW5lUHJvcGVydHk7XG5cbnZhciByaWdub3JlID0gbmV3IFJlZ0V4cChcbiAgICBcIlxcXFxiKD86W2EtekEtWjAtOS5dK1xcXFwkX1xcXFx3K3xcIiArXG4gICAgXCJ0cnlDYXRjaCg/OjF8MnwzfDR8QXBwbHkpfG5ldyBcXFxcdypQcm9taXNlQXJyYXl8XCIgK1xuICAgIFwiXFxcXHcqUHJvbWlzZUFycmF5XFxcXC5cXFxcdypQcm9taXNlQXJyYXl8XCIgK1xuICAgIFwic2V0VGltZW91dHxDYXRjaEZpbHRlclxcXFwkX1xcXFx3K3xtYWtlTm9kZVByb21pc2lmaWVkfHByb2Nlc3NJbW1lZGlhdGV8XCIgK1xuICAgIFwicHJvY2Vzcy5fdGlja0NhbGxiYWNrfG5leHRUaWNrfEFzeW5jXFxcXCRcXFxcdyspXFxcXGJcIlxuKTtcblxudmFyIHJ0cmFjZWxpbmUgPSBudWxsO1xudmFyIGZvcm1hdFN0YWNrID0gbnVsbDtcblxuZnVuY3Rpb24gZm9ybWF0Tm9uRXJyb3Iob2JqKSB7XG4gICAgdmFyIHN0cjtcbiAgICBpZiAodHlwZW9mIG9iaiA9PT0gXCJmdW5jdGlvblwiKSB7XG4gICAgICAgIHN0ciA9IFwiW2Z1bmN0aW9uIFwiICtcbiAgICAgICAgICAgIChvYmoubmFtZSB8fCBcImFub255bW91c1wiKSArXG4gICAgICAgICAgICBcIl1cIjtcbiAgICB9IGVsc2Uge1xuICAgICAgICBzdHIgPSBvYmoudG9TdHJpbmcoKTtcbiAgICAgICAgdmFyIHJ1c2VsZXNzVG9TdHJpbmcgPSAvXFxbb2JqZWN0IFthLXpBLVowLTkkX10rXFxdLztcbiAgICAgICAgaWYgKHJ1c2VsZXNzVG9TdHJpbmcudGVzdChzdHIpKSB7XG4gICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICAgIHZhciBuZXdTdHIgPSBKU09OLnN0cmluZ2lmeShvYmopO1xuICAgICAgICAgICAgICAgIHN0ciA9IG5ld1N0cjtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGNhdGNoKGUpIHtcblxuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICAgIGlmIChzdHIubGVuZ3RoID09PSAwKSB7XG4gICAgICAgICAgICBzdHIgPSBcIihlbXB0eSBhcnJheSlcIjtcbiAgICAgICAgfVxuICAgIH1cbiAgICByZXR1cm4gKFwiKDxcIiArIHNuaXAoc3RyKSArIFwiPiwgbm8gc3RhY2sgdHJhY2UpXCIpO1xufVxuXG5mdW5jdGlvbiBzbmlwKHN0cikge1xuICAgIHZhciBtYXhDaGFycyA9IDQxO1xuICAgIGlmIChzdHIubGVuZ3RoIDwgbWF4Q2hhcnMpIHtcbiAgICAgICAgcmV0dXJuIHN0cjtcbiAgICB9XG4gICAgcmV0dXJuIHN0ci5zdWJzdHIoMCwgbWF4Q2hhcnMgLSAzKSArIFwiLi4uXCI7XG59XG5cbmZ1bmN0aW9uIENhcHR1cmVkVHJhY2UoaWdub3JlVW50aWwsIGlzVG9wTGV2ZWwpIHtcbiAgICB0aGlzLmNhcHR1cmVTdGFja1RyYWNlKENhcHR1cmVkVHJhY2UsIGlzVG9wTGV2ZWwpO1xuXG59XG5pbmhlcml0cyhDYXB0dXJlZFRyYWNlLCBFcnJvcik7XG5cbkNhcHR1cmVkVHJhY2UucHJvdG90eXBlLmNhcHR1cmVTdGFja1RyYWNlID1cbmZ1bmN0aW9uIENhcHR1cmVkVHJhY2UkY2FwdHVyZVN0YWNrVHJhY2UoaWdub3JlVW50aWwsIGlzVG9wTGV2ZWwpIHtcbiAgICBjYXB0dXJlU3RhY2tUcmFjZSh0aGlzLCBpZ25vcmVVbnRpbCwgaXNUb3BMZXZlbCk7XG59O1xuXG5DYXB0dXJlZFRyYWNlLnBvc3NpYmx5VW5oYW5kbGVkUmVqZWN0aW9uID1cbmZ1bmN0aW9uIENhcHR1cmVkVHJhY2UkUG9zc2libHlVbmhhbmRsZWRSZWplY3Rpb24ocmVhc29uKSB7XG4gICAgaWYgKHR5cGVvZiBjb25zb2xlID09PSBcIm9iamVjdFwiKSB7XG4gICAgICAgIHZhciBtZXNzYWdlO1xuICAgICAgICBpZiAodHlwZW9mIHJlYXNvbiA9PT0gXCJvYmplY3RcIiB8fCB0eXBlb2YgcmVhc29uID09PSBcImZ1bmN0aW9uXCIpIHtcbiAgICAgICAgICAgIHZhciBzdGFjayA9IHJlYXNvbi5zdGFjaztcbiAgICAgICAgICAgIG1lc3NhZ2UgPSBcIlBvc3NpYmx5IHVuaGFuZGxlZCBcIiArIGZvcm1hdFN0YWNrKHN0YWNrLCByZWFzb24pO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgbWVzc2FnZSA9IFwiUG9zc2libHkgdW5oYW5kbGVkIFwiICsgU3RyaW5nKHJlYXNvbik7XG4gICAgICAgIH1cbiAgICAgICAgaWYgKHR5cGVvZiBjb25zb2xlLmVycm9yID09PSBcImZ1bmN0aW9uXCIgfHxcbiAgICAgICAgICAgIHR5cGVvZiBjb25zb2xlLmVycm9yID09PSBcIm9iamVjdFwiKSB7XG4gICAgICAgICAgICBjb25zb2xlLmVycm9yKG1lc3NhZ2UpO1xuICAgICAgICB9IGVsc2UgaWYgKHR5cGVvZiBjb25zb2xlLmxvZyA9PT0gXCJmdW5jdGlvblwiIHx8XG4gICAgICAgICAgICB0eXBlb2YgY29uc29sZS5sb2cgPT09IFwib2JqZWN0XCIpIHtcbiAgICAgICAgICAgIGNvbnNvbGUubG9nKG1lc3NhZ2UpO1xuICAgICAgICB9XG4gICAgfVxufTtcblxuQ2FwdHVyZWRUcmFjZS5jb21iaW5lID0gZnVuY3Rpb24gQ2FwdHVyZWRUcmFjZSRDb21iaW5lKGN1cnJlbnQsIHByZXYpIHtcbiAgICB2YXIgY3VycmVudExhc3RJbmRleCA9IGN1cnJlbnQubGVuZ3RoIC0gMTtcbiAgICB2YXIgY3VycmVudExhc3RMaW5lID0gY3VycmVudFtjdXJyZW50TGFzdEluZGV4XTtcbiAgICB2YXIgY29tbW9uUm9vdE1lZXRQb2ludCA9IC0xO1xuICAgIGZvciAodmFyIGkgPSBwcmV2Lmxlbmd0aCAtIDE7IGkgPj0gMDsgLS1pKSB7XG4gICAgICAgIGlmIChwcmV2W2ldID09PSBjdXJyZW50TGFzdExpbmUpIHtcbiAgICAgICAgICAgIGNvbW1vblJvb3RNZWV0UG9pbnQgPSBpO1xuICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICBmb3IgKHZhciBpID0gY29tbW9uUm9vdE1lZXRQb2ludDsgaSA+PSAwOyAtLWkpIHtcbiAgICAgICAgdmFyIGxpbmUgPSBwcmV2W2ldO1xuICAgICAgICBpZiAoY3VycmVudFtjdXJyZW50TGFzdEluZGV4XSA9PT0gbGluZSkge1xuICAgICAgICAgICAgY3VycmVudC5wb3AoKTtcbiAgICAgICAgICAgIGN1cnJlbnRMYXN0SW5kZXgtLTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgY3VycmVudC5wdXNoKFwiRnJvbSBwcmV2aW91cyBldmVudDpcIik7XG4gICAgdmFyIGxpbmVzID0gY3VycmVudC5jb25jYXQocHJldik7XG5cbiAgICB2YXIgcmV0ID0gW107XG5cbiAgICBmb3IgKHZhciBpID0gMCwgbGVuID0gbGluZXMubGVuZ3RoOyBpIDwgbGVuOyArK2kpIHtcblxuICAgICAgICBpZiAoKChyaWdub3JlLnRlc3QobGluZXNbaV0pICYmIHJ0cmFjZWxpbmUudGVzdChsaW5lc1tpXSkpIHx8XG4gICAgICAgICAgICAoaSA+IDAgJiYgIXJ0cmFjZWxpbmUudGVzdChsaW5lc1tpXSkpICYmXG4gICAgICAgICAgICBsaW5lc1tpXSAhPT0gXCJGcm9tIHByZXZpb3VzIGV2ZW50OlwiKVxuICAgICAgICkge1xuICAgICAgICAgICAgY29udGludWU7XG4gICAgICAgIH1cbiAgICAgICAgcmV0LnB1c2gobGluZXNbaV0pO1xuICAgIH1cbiAgICByZXR1cm4gcmV0O1xufTtcblxuQ2FwdHVyZWRUcmFjZS5wcm90ZWN0RXJyb3JNZXNzYWdlTmV3bGluZXMgPSBmdW5jdGlvbihzdGFjaykge1xuICAgIGZvciAodmFyIGkgPSAwOyBpIDwgc3RhY2subGVuZ3RoOyArK2kpIHtcbiAgICAgICAgaWYgKHJ0cmFjZWxpbmUudGVzdChzdGFja1tpXSkpIHtcbiAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgaWYgKGkgPD0gMSkgcmV0dXJuO1xuXG4gICAgdmFyIGVycm9yTWVzc2FnZUxpbmVzID0gW107XG4gICAgZm9yICh2YXIgaiA9IDA7IGogPCBpOyArK2opIHtcbiAgICAgICAgZXJyb3JNZXNzYWdlTGluZXMucHVzaChzdGFjay5zaGlmdCgpKTtcbiAgICB9XG4gICAgc3RhY2sudW5zaGlmdChlcnJvck1lc3NhZ2VMaW5lcy5qb2luKFwiXFx1MDAwMlxcdTAwMDBcXHUwMDAxXCIpKTtcbn07XG5cbkNhcHR1cmVkVHJhY2UuaXNTdXBwb3J0ZWQgPSBmdW5jdGlvbiBDYXB0dXJlZFRyYWNlJElzU3VwcG9ydGVkKCkge1xuICAgIHJldHVybiB0eXBlb2YgY2FwdHVyZVN0YWNrVHJhY2UgPT09IFwiZnVuY3Rpb25cIjtcbn07XG5cbnZhciBjYXB0dXJlU3RhY2tUcmFjZSA9IChmdW5jdGlvbiBzdGFja0RldGVjdGlvbigpIHtcbiAgICBpZiAodHlwZW9mIEVycm9yLnN0YWNrVHJhY2VMaW1pdCA9PT0gXCJudW1iZXJcIiAmJlxuICAgICAgICB0eXBlb2YgRXJyb3IuY2FwdHVyZVN0YWNrVHJhY2UgPT09IFwiZnVuY3Rpb25cIikge1xuICAgICAgICBydHJhY2VsaW5lID0gL15cXHMqYXRcXHMqLztcbiAgICAgICAgZm9ybWF0U3RhY2sgPSBmdW5jdGlvbihzdGFjaywgZXJyb3IpIHtcbiAgICAgICAgICAgIGlmICh0eXBlb2Ygc3RhY2sgPT09IFwic3RyaW5nXCIpIHJldHVybiBzdGFjaztcblxuICAgICAgICAgICAgaWYgKGVycm9yLm5hbWUgIT09IHZvaWQgMCAmJlxuICAgICAgICAgICAgICAgIGVycm9yLm1lc3NhZ2UgIT09IHZvaWQgMCkge1xuICAgICAgICAgICAgICAgIHJldHVybiBlcnJvci5uYW1lICsgXCIuIFwiICsgZXJyb3IubWVzc2FnZTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHJldHVybiBmb3JtYXROb25FcnJvcihlcnJvcik7XG5cblxuICAgICAgICB9O1xuICAgICAgICB2YXIgY2FwdHVyZVN0YWNrVHJhY2UgPSBFcnJvci5jYXB0dXJlU3RhY2tUcmFjZTtcbiAgICAgICAgcmV0dXJuIGZ1bmN0aW9uIENhcHR1cmVkVHJhY2UkX2NhcHR1cmVTdGFja1RyYWNlKFxuICAgICAgICAgICAgcmVjZWl2ZXIsIGlnbm9yZVVudGlsKSB7XG4gICAgICAgICAgICBjYXB0dXJlU3RhY2tUcmFjZShyZWNlaXZlciwgaWdub3JlVW50aWwpO1xuICAgICAgICB9O1xuICAgIH1cbiAgICB2YXIgZXJyID0gbmV3IEVycm9yKCk7XG5cbiAgICBpZiAodHlwZW9mIGVyci5zdGFjayA9PT0gXCJzdHJpbmdcIiAmJlxuICAgICAgICB0eXBlb2YgXCJcIi5zdGFydHNXaXRoID09PSBcImZ1bmN0aW9uXCIgJiZcbiAgICAgICAgKGVyci5zdGFjay5zdGFydHNXaXRoKFwic3RhY2tEZXRlY3Rpb25AXCIpKSAmJlxuICAgICAgICBzdGFja0RldGVjdGlvbi5uYW1lID09PSBcInN0YWNrRGV0ZWN0aW9uXCIpIHtcblxuICAgICAgICBkZWZpbmVQcm9wZXJ0eShFcnJvciwgXCJzdGFja1RyYWNlTGltaXRcIiwge1xuICAgICAgICAgICAgd3JpdGFibGU6IHRydWUsXG4gICAgICAgICAgICBlbnVtZXJhYmxlOiBmYWxzZSxcbiAgICAgICAgICAgIGNvbmZpZ3VyYWJsZTogZmFsc2UsXG4gICAgICAgICAgICB2YWx1ZTogMjVcbiAgICAgICAgfSk7XG4gICAgICAgIHJ0cmFjZWxpbmUgPSAvQC87XG4gICAgICAgIHZhciBybGluZSA9IC9bQFxcbl0vO1xuXG4gICAgICAgIGZvcm1hdFN0YWNrID0gZnVuY3Rpb24oc3RhY2ssIGVycm9yKSB7XG4gICAgICAgICAgICBpZiAodHlwZW9mIHN0YWNrID09PSBcInN0cmluZ1wiKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIChlcnJvci5uYW1lICsgXCIuIFwiICsgZXJyb3IubWVzc2FnZSArIFwiXFxuXCIgKyBzdGFjayk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmIChlcnJvci5uYW1lICE9PSB2b2lkIDAgJiZcbiAgICAgICAgICAgICAgICBlcnJvci5tZXNzYWdlICE9PSB2b2lkIDApIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gZXJyb3IubmFtZSArIFwiLiBcIiArIGVycm9yLm1lc3NhZ2U7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICByZXR1cm4gZm9ybWF0Tm9uRXJyb3IoZXJyb3IpO1xuICAgICAgICB9O1xuXG4gICAgICAgIHJldHVybiBmdW5jdGlvbiBjYXB0dXJlU3RhY2tUcmFjZShvKSB7XG4gICAgICAgICAgICB2YXIgc3RhY2sgPSBuZXcgRXJyb3IoKS5zdGFjaztcbiAgICAgICAgICAgIHZhciBzcGxpdCA9IHN0YWNrLnNwbGl0KHJsaW5lKTtcbiAgICAgICAgICAgIHZhciBsZW4gPSBzcGxpdC5sZW5ndGg7XG4gICAgICAgICAgICB2YXIgcmV0ID0gXCJcIjtcbiAgICAgICAgICAgIGZvciAodmFyIGkgPSAwOyBpIDwgbGVuOyBpICs9IDIpIHtcbiAgICAgICAgICAgICAgICByZXQgKz0gc3BsaXRbaV07XG4gICAgICAgICAgICAgICAgcmV0ICs9IFwiQFwiO1xuICAgICAgICAgICAgICAgIHJldCArPSBzcGxpdFtpICsgMV07XG4gICAgICAgICAgICAgICAgcmV0ICs9IFwiXFxuXCI7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBvLnN0YWNrID0gcmV0O1xuICAgICAgICB9O1xuICAgIH0gZWxzZSB7XG4gICAgICAgIGZvcm1hdFN0YWNrID0gZnVuY3Rpb24oc3RhY2ssIGVycm9yKSB7XG4gICAgICAgICAgICBpZiAodHlwZW9mIHN0YWNrID09PSBcInN0cmluZ1wiKSByZXR1cm4gc3RhY2s7XG5cbiAgICAgICAgICAgIGlmICgodHlwZW9mIGVycm9yID09PSBcIm9iamVjdFwiIHx8XG4gICAgICAgICAgICAgICAgdHlwZW9mIGVycm9yID09PSBcImZ1bmN0aW9uXCIpICYmXG4gICAgICAgICAgICAgICAgZXJyb3IubmFtZSAhPT0gdm9pZCAwICYmXG4gICAgICAgICAgICAgICAgZXJyb3IubWVzc2FnZSAhPT0gdm9pZCAwKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIGVycm9yLm5hbWUgKyBcIi4gXCIgKyBlcnJvci5tZXNzYWdlO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgcmV0dXJuIGZvcm1hdE5vbkVycm9yKGVycm9yKTtcbiAgICAgICAgfTtcblxuICAgICAgICByZXR1cm4gbnVsbDtcbiAgICB9XG59KSgpO1xuXG5yZXR1cm4gQ2FwdHVyZWRUcmFjZTtcbn07XG4iLCIvKipcbiAqIFRoZSBNSVQgTGljZW5zZSAoTUlUKVxuICogXG4gKiBDb3B5cmlnaHQgKGMpIDIwMTQgUGV0a2EgQW50b25vdlxuICogXG4gKiBQZXJtaXNzaW9uIGlzIGhlcmVieSBncmFudGVkLCBmcmVlIG9mIGNoYXJnZSwgdG8gYW55IHBlcnNvbiBvYnRhaW5pbmcgYSBjb3B5XG4gKiBvZiB0aGlzIHNvZnR3YXJlIGFuZCBhc3NvY2lhdGVkIGRvY3VtZW50YXRpb24gZmlsZXMgKHRoZSBcIlNvZnR3YXJlXCIpLCB0byBkZWFsXG4gKiBpbiB0aGUgU29mdHdhcmUgd2l0aG91dCByZXN0cmljdGlvbiwgaW5jbHVkaW5nIHdpdGhvdXQgbGltaXRhdGlvbiB0aGUgcmlnaHRzXG4gKiB0byB1c2UsIGNvcHksIG1vZGlmeSwgbWVyZ2UsIHB1Ymxpc2gsIGRpc3RyaWJ1dGUsIHN1YmxpY2Vuc2UsIGFuZC9vciBzZWxsXG4gKiBjb3BpZXMgb2YgdGhlIFNvZnR3YXJlLCBhbmQgdG8gcGVybWl0IHBlcnNvbnMgdG8gd2hvbSB0aGUgU29mdHdhcmUgaXNcbiAqIGZ1cm5pc2hlZCB0byBkbyBzbywgc3ViamVjdCB0byB0aGUgZm9sbG93aW5nIGNvbmRpdGlvbnM6PC9wPlxuICogXG4gKiBUaGUgYWJvdmUgY29weXJpZ2h0IG5vdGljZSBhbmQgdGhpcyBwZXJtaXNzaW9uIG5vdGljZSBzaGFsbCBiZSBpbmNsdWRlZCBpblxuICogYWxsIGNvcGllcyBvciBzdWJzdGFudGlhbCBwb3J0aW9ucyBvZiB0aGUgU29mdHdhcmUuXG4gKiBcbiAqIFRIRSBTT0ZUV0FSRSBJUyBQUk9WSURFRCBcIkFTIElTXCIsIFdJVEhPVVQgV0FSUkFOVFkgT0YgQU5ZIEtJTkQsIEVYUFJFU1MgT1JcbiAqIElNUExJRUQsIElOQ0xVRElORyBCVVQgTk9UIExJTUlURUQgVE8gVEhFIFdBUlJBTlRJRVMgT0YgTUVSQ0hBTlRBQklMSVRZLFxuICogRklUTkVTUyBGT1IgQSBQQVJUSUNVTEFSIFBVUlBPU0UgQU5EIE5PTklORlJJTkdFTUVOVC4gIElOIE5PIEVWRU5UIFNIQUxMIFRIRVxuICogQVVUSE9SUyBPUiBDT1BZUklHSFQgSE9MREVSUyBCRSBMSUFCTEUgRk9SIEFOWSBDTEFJTSwgREFNQUdFUyBPUiBPVEhFUlxuICogTElBQklMSVRZLCBXSEVUSEVSIElOIEFOIEFDVElPTiBPRiBDT05UUkFDVCwgVE9SVCBPUiBPVEhFUldJU0UsIEFSSVNJTkcgRlJPTSxcbiAqIE9VVCBPRiBPUiBJTiBDT05ORUNUSU9OIFdJVEggVEhFIFNPRlRXQVJFIE9SIFRIRSBVU0UgT1IgT1RIRVIgREVBTElOR1MgSU5cbiAqIFRIRSBTT0ZUV0FSRS5cbiAqIFxuICovXG5cInVzZSBzdHJpY3RcIjtcbm1vZHVsZS5leHBvcnRzID0gZnVuY3Rpb24oTkVYVF9GSUxURVIpIHtcbnZhciB1dGlsID0gcmVxdWlyZShcIi4vdXRpbC5qc1wiKTtcbnZhciBlcnJvcnMgPSByZXF1aXJlKFwiLi9lcnJvcnMuanNcIik7XG52YXIgdHJ5Q2F0Y2gxID0gdXRpbC50cnlDYXRjaDE7XG52YXIgZXJyb3JPYmogPSB1dGlsLmVycm9yT2JqO1xudmFyIGtleXMgPSByZXF1aXJlKFwiLi9lczUuanNcIikua2V5cztcbnZhciBUeXBlRXJyb3IgPSBlcnJvcnMuVHlwZUVycm9yO1xuXG5mdW5jdGlvbiBDYXRjaEZpbHRlcihpbnN0YW5jZXMsIGNhbGxiYWNrLCBwcm9taXNlKSB7XG4gICAgdGhpcy5faW5zdGFuY2VzID0gaW5zdGFuY2VzO1xuICAgIHRoaXMuX2NhbGxiYWNrID0gY2FsbGJhY2s7XG4gICAgdGhpcy5fcHJvbWlzZSA9IHByb21pc2U7XG59XG5cbmZ1bmN0aW9uIENhdGNoRmlsdGVyJF9zYWZlUHJlZGljYXRlKHByZWRpY2F0ZSwgZSkge1xuICAgIHZhciBzYWZlT2JqZWN0ID0ge307XG4gICAgdmFyIHJldGZpbHRlciA9IHRyeUNhdGNoMShwcmVkaWNhdGUsIHNhZmVPYmplY3QsIGUpO1xuXG4gICAgaWYgKHJldGZpbHRlciA9PT0gZXJyb3JPYmopIHJldHVybiByZXRmaWx0ZXI7XG5cbiAgICB2YXIgc2FmZUtleXMgPSBrZXlzKHNhZmVPYmplY3QpO1xuICAgIGlmIChzYWZlS2V5cy5sZW5ndGgpIHtcbiAgICAgICAgZXJyb3JPYmouZSA9IG5ldyBUeXBlRXJyb3IoXG4gICAgICAgICAgICBcIkNhdGNoIGZpbHRlciBtdXN0IGluaGVyaXQgZnJvbSBFcnJvciBcIlxuICAgICAgICAgICsgXCJvciBiZSBhIHNpbXBsZSBwcmVkaWNhdGUgZnVuY3Rpb25cIik7XG4gICAgICAgIHJldHVybiBlcnJvck9iajtcbiAgICB9XG4gICAgcmV0dXJuIHJldGZpbHRlcjtcbn1cblxuQ2F0Y2hGaWx0ZXIucHJvdG90eXBlLmRvRmlsdGVyID0gZnVuY3Rpb24gQ2F0Y2hGaWx0ZXIkX2RvRmlsdGVyKGUpIHtcbiAgICB2YXIgY2IgPSB0aGlzLl9jYWxsYmFjaztcbiAgICB2YXIgcHJvbWlzZSA9IHRoaXMuX3Byb21pc2U7XG4gICAgdmFyIGJvdW5kVG8gPSBwcm9taXNlLl9ib3VuZFRvO1xuICAgIGZvciAodmFyIGkgPSAwLCBsZW4gPSB0aGlzLl9pbnN0YW5jZXMubGVuZ3RoOyBpIDwgbGVuOyArK2kpIHtcbiAgICAgICAgdmFyIGl0ZW0gPSB0aGlzLl9pbnN0YW5jZXNbaV07XG4gICAgICAgIHZhciBpdGVtSXNFcnJvclR5cGUgPSBpdGVtID09PSBFcnJvciB8fFxuICAgICAgICAgICAgKGl0ZW0gIT0gbnVsbCAmJiBpdGVtLnByb3RvdHlwZSBpbnN0YW5jZW9mIEVycm9yKTtcblxuICAgICAgICBpZiAoaXRlbUlzRXJyb3JUeXBlICYmIGUgaW5zdGFuY2VvZiBpdGVtKSB7XG4gICAgICAgICAgICB2YXIgcmV0ID0gdHJ5Q2F0Y2gxKGNiLCBib3VuZFRvLCBlKTtcbiAgICAgICAgICAgIGlmIChyZXQgPT09IGVycm9yT2JqKSB7XG4gICAgICAgICAgICAgICAgTkVYVF9GSUxURVIuZSA9IHJldC5lO1xuICAgICAgICAgICAgICAgIHJldHVybiBORVhUX0ZJTFRFUjtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHJldHVybiByZXQ7XG4gICAgICAgIH0gZWxzZSBpZiAodHlwZW9mIGl0ZW0gPT09IFwiZnVuY3Rpb25cIiAmJiAhaXRlbUlzRXJyb3JUeXBlKSB7XG4gICAgICAgICAgICB2YXIgc2hvdWxkSGFuZGxlID0gQ2F0Y2hGaWx0ZXIkX3NhZmVQcmVkaWNhdGUoaXRlbSwgZSk7XG4gICAgICAgICAgICBpZiAoc2hvdWxkSGFuZGxlID09PSBlcnJvck9iaikge1xuICAgICAgICAgICAgICAgIHZhciB0cmFjZSA9IGVycm9ycy5jYW5BdHRhY2goZXJyb3JPYmouZSlcbiAgICAgICAgICAgICAgICAgICAgPyBlcnJvck9iai5lXG4gICAgICAgICAgICAgICAgICAgIDogbmV3IEVycm9yKGVycm9yT2JqLmUgKyBcIlwiKTtcbiAgICAgICAgICAgICAgICB0aGlzLl9wcm9taXNlLl9hdHRhY2hFeHRyYVRyYWNlKHRyYWNlKTtcbiAgICAgICAgICAgICAgICBlID0gZXJyb3JPYmouZTtcbiAgICAgICAgICAgICAgICBicmVhaztcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoc2hvdWxkSGFuZGxlKSB7XG4gICAgICAgICAgICAgICAgdmFyIHJldCA9IHRyeUNhdGNoMShjYiwgYm91bmRUbywgZSk7XG4gICAgICAgICAgICAgICAgaWYgKHJldCA9PT0gZXJyb3JPYmopIHtcbiAgICAgICAgICAgICAgICAgICAgTkVYVF9GSUxURVIuZSA9IHJldC5lO1xuICAgICAgICAgICAgICAgICAgICByZXR1cm4gTkVYVF9GSUxURVI7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIHJldHVybiByZXQ7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICB9XG4gICAgTkVYVF9GSUxURVIuZSA9IGU7XG4gICAgcmV0dXJuIE5FWFRfRklMVEVSO1xufTtcblxucmV0dXJuIENhdGNoRmlsdGVyO1xufTtcbiIsIi8qKlxuICogVGhlIE1JVCBMaWNlbnNlIChNSVQpXG4gKiBcbiAqIENvcHlyaWdodCAoYykgMjAxNCBQZXRrYSBBbnRvbm92XG4gKiBcbiAqIFBlcm1pc3Npb24gaXMgaGVyZWJ5IGdyYW50ZWQsIGZyZWUgb2YgY2hhcmdlLCB0byBhbnkgcGVyc29uIG9idGFpbmluZyBhIGNvcHlcbiAqIG9mIHRoaXMgc29mdHdhcmUgYW5kIGFzc29jaWF0ZWQgZG9jdW1lbnRhdGlvbiBmaWxlcyAodGhlIFwiU29mdHdhcmVcIiksIHRvIGRlYWxcbiAqIGluIHRoZSBTb2Z0d2FyZSB3aXRob3V0IHJlc3RyaWN0aW9uLCBpbmNsdWRpbmcgd2l0aG91dCBsaW1pdGF0aW9uIHRoZSByaWdodHNcbiAqIHRvIHVzZSwgY29weSwgbW9kaWZ5LCBtZXJnZSwgcHVibGlzaCwgZGlzdHJpYnV0ZSwgc3VibGljZW5zZSwgYW5kL29yIHNlbGxcbiAqIGNvcGllcyBvZiB0aGUgU29mdHdhcmUsIGFuZCB0byBwZXJtaXQgcGVyc29ucyB0byB3aG9tIHRoZSBTb2Z0d2FyZSBpc1xuICogZnVybmlzaGVkIHRvIGRvIHNvLCBzdWJqZWN0IHRvIHRoZSBmb2xsb3dpbmcgY29uZGl0aW9uczo8L3A+XG4gKiBcbiAqIFRoZSBhYm92ZSBjb3B5cmlnaHQgbm90aWNlIGFuZCB0aGlzIHBlcm1pc3Npb24gbm90aWNlIHNoYWxsIGJlIGluY2x1ZGVkIGluXG4gKiBhbGwgY29waWVzIG9yIHN1YnN0YW50aWFsIHBvcnRpb25zIG9mIHRoZSBTb2Z0d2FyZS5cbiAqIFxuICogVEhFIFNPRlRXQVJFIElTIFBST1ZJREVEIFwiQVMgSVNcIiwgV0lUSE9VVCBXQVJSQU5UWSBPRiBBTlkgS0lORCwgRVhQUkVTUyBPUlxuICogSU1QTElFRCwgSU5DTFVESU5HIEJVVCBOT1QgTElNSVRFRCBUTyBUSEUgV0FSUkFOVElFUyBPRiBNRVJDSEFOVEFCSUxJVFksXG4gKiBGSVRORVNTIEZPUiBBIFBBUlRJQ1VMQVIgUFVSUE9TRSBBTkQgTk9OSU5GUklOR0VNRU5ULiAgSU4gTk8gRVZFTlQgU0hBTEwgVEhFXG4gKiBBVVRIT1JTIE9SIENPUFlSSUdIVCBIT0xERVJTIEJFIExJQUJMRSBGT1IgQU5ZIENMQUlNLCBEQU1BR0VTIE9SIE9USEVSXG4gKiBMSUFCSUxJVFksIFdIRVRIRVIgSU4gQU4gQUNUSU9OIE9GIENPTlRSQUNULCBUT1JUIE9SIE9USEVSV0lTRSwgQVJJU0lORyBGUk9NLFxuICogT1VUIE9GIE9SIElOIENPTk5FQ1RJT04gV0lUSCBUSEUgU09GVFdBUkUgT1IgVEhFIFVTRSBPUiBPVEhFUiBERUFMSU5HUyBJTlxuICogVEhFIFNPRlRXQVJFLlxuICogXG4gKi9cblwidXNlIHN0cmljdFwiO1xudmFyIHV0aWwgPSByZXF1aXJlKFwiLi91dGlsLmpzXCIpO1xudmFyIGlzUHJpbWl0aXZlID0gdXRpbC5pc1ByaW1pdGl2ZTtcbnZhciB3cmFwc1ByaW1pdGl2ZVJlY2VpdmVyID0gdXRpbC53cmFwc1ByaW1pdGl2ZVJlY2VpdmVyO1xuXG5tb2R1bGUuZXhwb3J0cyA9IGZ1bmN0aW9uKFByb21pc2UpIHtcbnZhciByZXR1cm5lciA9IGZ1bmN0aW9uIFByb21pc2UkX3JldHVybmVyKCkge1xuICAgIHJldHVybiB0aGlzO1xufTtcbnZhciB0aHJvd2VyID0gZnVuY3Rpb24gUHJvbWlzZSRfdGhyb3dlcigpIHtcbiAgICB0aHJvdyB0aGlzO1xufTtcblxudmFyIHdyYXBwZXIgPSBmdW5jdGlvbiBQcm9taXNlJF93cmFwcGVyKHZhbHVlLCBhY3Rpb24pIHtcbiAgICBpZiAoYWN0aW9uID09PSAxKSB7XG4gICAgICAgIHJldHVybiBmdW5jdGlvbiBQcm9taXNlJF90aHJvd2VyKCkge1xuICAgICAgICAgICAgdGhyb3cgdmFsdWU7XG4gICAgICAgIH07XG4gICAgfSBlbHNlIGlmIChhY3Rpb24gPT09IDIpIHtcbiAgICAgICAgcmV0dXJuIGZ1bmN0aW9uIFByb21pc2UkX3JldHVybmVyKCkge1xuICAgICAgICAgICAgcmV0dXJuIHZhbHVlO1xuICAgICAgICB9O1xuICAgIH1cbn07XG5cblxuUHJvbWlzZS5wcm90b3R5cGVbXCJyZXR1cm5cIl0gPVxuUHJvbWlzZS5wcm90b3R5cGUudGhlblJldHVybiA9XG5mdW5jdGlvbiBQcm9taXNlJHRoZW5SZXR1cm4odmFsdWUpIHtcbiAgICBpZiAod3JhcHNQcmltaXRpdmVSZWNlaXZlciAmJiBpc1ByaW1pdGl2ZSh2YWx1ZSkpIHtcbiAgICAgICAgcmV0dXJuIHRoaXMuX3RoZW4oXG4gICAgICAgICAgICB3cmFwcGVyKHZhbHVlLCAyKSxcbiAgICAgICAgICAgIHZvaWQgMCxcbiAgICAgICAgICAgIHZvaWQgMCxcbiAgICAgICAgICAgIHZvaWQgMCxcbiAgICAgICAgICAgIHZvaWQgMFxuICAgICAgICk7XG4gICAgfVxuICAgIHJldHVybiB0aGlzLl90aGVuKHJldHVybmVyLCB2b2lkIDAsIHZvaWQgMCwgdmFsdWUsIHZvaWQgMCk7XG59O1xuXG5Qcm9taXNlLnByb3RvdHlwZVtcInRocm93XCJdID1cblByb21pc2UucHJvdG90eXBlLnRoZW5UaHJvdyA9XG5mdW5jdGlvbiBQcm9taXNlJHRoZW5UaHJvdyhyZWFzb24pIHtcbiAgICBpZiAod3JhcHNQcmltaXRpdmVSZWNlaXZlciAmJiBpc1ByaW1pdGl2ZShyZWFzb24pKSB7XG4gICAgICAgIHJldHVybiB0aGlzLl90aGVuKFxuICAgICAgICAgICAgd3JhcHBlcihyZWFzb24sIDEpLFxuICAgICAgICAgICAgdm9pZCAwLFxuICAgICAgICAgICAgdm9pZCAwLFxuICAgICAgICAgICAgdm9pZCAwLFxuICAgICAgICAgICAgdm9pZCAwXG4gICAgICAgKTtcbiAgICB9XG4gICAgcmV0dXJuIHRoaXMuX3RoZW4odGhyb3dlciwgdm9pZCAwLCB2b2lkIDAsIHJlYXNvbiwgdm9pZCAwKTtcbn07XG59O1xuIiwiLyoqXG4gKiBUaGUgTUlUIExpY2Vuc2UgKE1JVClcbiAqIFxuICogQ29weXJpZ2h0IChjKSAyMDE0IFBldGthIEFudG9ub3ZcbiAqIFxuICogUGVybWlzc2lvbiBpcyBoZXJlYnkgZ3JhbnRlZCwgZnJlZSBvZiBjaGFyZ2UsIHRvIGFueSBwZXJzb24gb2J0YWluaW5nIGEgY29weVxuICogb2YgdGhpcyBzb2Z0d2FyZSBhbmQgYXNzb2NpYXRlZCBkb2N1bWVudGF0aW9uIGZpbGVzICh0aGUgXCJTb2Z0d2FyZVwiKSwgdG8gZGVhbFxuICogaW4gdGhlIFNvZnR3YXJlIHdpdGhvdXQgcmVzdHJpY3Rpb24sIGluY2x1ZGluZyB3aXRob3V0IGxpbWl0YXRpb24gdGhlIHJpZ2h0c1xuICogdG8gdXNlLCBjb3B5LCBtb2RpZnksIG1lcmdlLCBwdWJsaXNoLCBkaXN0cmlidXRlLCBzdWJsaWNlbnNlLCBhbmQvb3Igc2VsbFxuICogY29waWVzIG9mIHRoZSBTb2Z0d2FyZSwgYW5kIHRvIHBlcm1pdCBwZXJzb25zIHRvIHdob20gdGhlIFNvZnR3YXJlIGlzXG4gKiBmdXJuaXNoZWQgdG8gZG8gc28sIHN1YmplY3QgdG8gdGhlIGZvbGxvd2luZyBjb25kaXRpb25zOjwvcD5cbiAqIFxuICogVGhlIGFib3ZlIGNvcHlyaWdodCBub3RpY2UgYW5kIHRoaXMgcGVybWlzc2lvbiBub3RpY2Ugc2hhbGwgYmUgaW5jbHVkZWQgaW5cbiAqIGFsbCBjb3BpZXMgb3Igc3Vic3RhbnRpYWwgcG9ydGlvbnMgb2YgdGhlIFNvZnR3YXJlLlxuICogXG4gKiBUSEUgU09GVFdBUkUgSVMgUFJPVklERUQgXCJBUyBJU1wiLCBXSVRIT1VUIFdBUlJBTlRZIE9GIEFOWSBLSU5ELCBFWFBSRVNTIE9SXG4gKiBJTVBMSUVELCBJTkNMVURJTkcgQlVUIE5PVCBMSU1JVEVEIFRPIFRIRSBXQVJSQU5USUVTIE9GIE1FUkNIQU5UQUJJTElUWSxcbiAqIEZJVE5FU1MgRk9SIEEgUEFSVElDVUxBUiBQVVJQT1NFIEFORCBOT05JTkZSSU5HRU1FTlQuICBJTiBOTyBFVkVOVCBTSEFMTCBUSEVcbiAqIEFVVEhPUlMgT1IgQ09QWVJJR0hUIEhPTERFUlMgQkUgTElBQkxFIEZPUiBBTlkgQ0xBSU0sIERBTUFHRVMgT1IgT1RIRVJcbiAqIExJQUJJTElUWSwgV0hFVEhFUiBJTiBBTiBBQ1RJT04gT0YgQ09OVFJBQ1QsIFRPUlQgT1IgT1RIRVJXSVNFLCBBUklTSU5HIEZST00sXG4gKiBPVVQgT0YgT1IgSU4gQ09OTkVDVElPTiBXSVRIIFRIRSBTT0ZUV0FSRSBPUiBUSEUgVVNFIE9SIE9USEVSIERFQUxJTkdTIElOXG4gKiBUSEUgU09GVFdBUkUuXG4gKiBcbiAqL1xuXCJ1c2Ugc3RyaWN0XCI7XG5tb2R1bGUuZXhwb3J0cyA9IGZ1bmN0aW9uKFByb21pc2UsIElOVEVSTkFMKSB7XG52YXIgUHJvbWlzZVJlZHVjZSA9IFByb21pc2UucmVkdWNlO1xuXG5Qcm9taXNlLnByb3RvdHlwZS5lYWNoID0gZnVuY3Rpb24gUHJvbWlzZSRlYWNoKGZuKSB7XG4gICAgcmV0dXJuIFByb21pc2VSZWR1Y2UodGhpcywgZm4sIG51bGwsIElOVEVSTkFMKTtcbn07XG5cblByb21pc2UuZWFjaCA9IGZ1bmN0aW9uIFByb21pc2UkRWFjaChwcm9taXNlcywgZm4pIHtcbiAgICByZXR1cm4gUHJvbWlzZVJlZHVjZShwcm9taXNlcywgZm4sIG51bGwsIElOVEVSTkFMKTtcbn07XG59O1xuIiwiLyoqXG4gKiBUaGUgTUlUIExpY2Vuc2UgKE1JVClcbiAqIFxuICogQ29weXJpZ2h0IChjKSAyMDE0IFBldGthIEFudG9ub3ZcbiAqIFxuICogUGVybWlzc2lvbiBpcyBoZXJlYnkgZ3JhbnRlZCwgZnJlZSBvZiBjaGFyZ2UsIHRvIGFueSBwZXJzb24gb2J0YWluaW5nIGEgY29weVxuICogb2YgdGhpcyBzb2Z0d2FyZSBhbmQgYXNzb2NpYXRlZCBkb2N1bWVudGF0aW9uIGZpbGVzICh0aGUgXCJTb2Z0d2FyZVwiKSwgdG8gZGVhbFxuICogaW4gdGhlIFNvZnR3YXJlIHdpdGhvdXQgcmVzdHJpY3Rpb24sIGluY2x1ZGluZyB3aXRob3V0IGxpbWl0YXRpb24gdGhlIHJpZ2h0c1xuICogdG8gdXNlLCBjb3B5LCBtb2RpZnksIG1lcmdlLCBwdWJsaXNoLCBkaXN0cmlidXRlLCBzdWJsaWNlbnNlLCBhbmQvb3Igc2VsbFxuICogY29waWVzIG9mIHRoZSBTb2Z0d2FyZSwgYW5kIHRvIHBlcm1pdCBwZXJzb25zIHRvIHdob20gdGhlIFNvZnR3YXJlIGlzXG4gKiBmdXJuaXNoZWQgdG8gZG8gc28sIHN1YmplY3QgdG8gdGhlIGZvbGxvd2luZyBjb25kaXRpb25zOjwvcD5cbiAqIFxuICogVGhlIGFib3ZlIGNvcHlyaWdodCBub3RpY2UgYW5kIHRoaXMgcGVybWlzc2lvbiBub3RpY2Ugc2hhbGwgYmUgaW5jbHVkZWQgaW5cbiAqIGFsbCBjb3BpZXMgb3Igc3Vic3RhbnRpYWwgcG9ydGlvbnMgb2YgdGhlIFNvZnR3YXJlLlxuICogXG4gKiBUSEUgU09GVFdBUkUgSVMgUFJPVklERUQgXCJBUyBJU1wiLCBXSVRIT1VUIFdBUlJBTlRZIE9GIEFOWSBLSU5ELCBFWFBSRVNTIE9SXG4gKiBJTVBMSUVELCBJTkNMVURJTkcgQlVUIE5PVCBMSU1JVEVEIFRPIFRIRSBXQVJSQU5USUVTIE9GIE1FUkNIQU5UQUJJTElUWSxcbiAqIEZJVE5FU1MgRk9SIEEgUEFSVElDVUxBUiBQVVJQT1NFIEFORCBOT05JTkZSSU5HRU1FTlQuICBJTiBOTyBFVkVOVCBTSEFMTCBUSEVcbiAqIEFVVEhPUlMgT1IgQ09QWVJJR0hUIEhPTERFUlMgQkUgTElBQkxFIEZPUiBBTlkgQ0xBSU0sIERBTUFHRVMgT1IgT1RIRVJcbiAqIExJQUJJTElUWSwgV0hFVEhFUiBJTiBBTiBBQ1RJT04gT0YgQ09OVFJBQ1QsIFRPUlQgT1IgT1RIRVJXSVNFLCBBUklTSU5HIEZST00sXG4gKiBPVVQgT0YgT1IgSU4gQ09OTkVDVElPTiBXSVRIIFRIRSBTT0ZUV0FSRSBPUiBUSEUgVVNFIE9SIE9USEVSIERFQUxJTkdTIElOXG4gKiBUSEUgU09GVFdBUkUuXG4gKiBcbiAqL1xuXCJ1c2Ugc3RyaWN0XCI7XG52YXIgT2JqZWN0ZnJlZXplID0gcmVxdWlyZShcIi4vZXM1LmpzXCIpLmZyZWV6ZTtcbnZhciB1dGlsID0gcmVxdWlyZShcIi4vdXRpbC5qc1wiKTtcbnZhciBpbmhlcml0cyA9IHV0aWwuaW5oZXJpdHM7XG52YXIgbm90RW51bWVyYWJsZVByb3AgPSB1dGlsLm5vdEVudW1lcmFibGVQcm9wO1xuXG5mdW5jdGlvbiBtYXJrQXNPcmlnaW5hdGluZ0Zyb21SZWplY3Rpb24oZSkge1xuICAgIHRyeSB7XG4gICAgICAgIG5vdEVudW1lcmFibGVQcm9wKGUsIFwiaXNPcGVyYXRpb25hbFwiLCB0cnVlKTtcbiAgICB9XG4gICAgY2F0Y2goaWdub3JlKSB7fVxufVxuXG5mdW5jdGlvbiBvcmlnaW5hdGVzRnJvbVJlamVjdGlvbihlKSB7XG4gICAgaWYgKGUgPT0gbnVsbCkgcmV0dXJuIGZhbHNlO1xuICAgIHJldHVybiAoKGUgaW5zdGFuY2VvZiBPcGVyYXRpb25hbEVycm9yKSB8fFxuICAgICAgICBlW1wiaXNPcGVyYXRpb25hbFwiXSA9PT0gdHJ1ZSk7XG59XG5cbmZ1bmN0aW9uIGlzRXJyb3Iob2JqKSB7XG4gICAgcmV0dXJuIG9iaiBpbnN0YW5jZW9mIEVycm9yO1xufVxuXG5mdW5jdGlvbiBjYW5BdHRhY2gob2JqKSB7XG4gICAgcmV0dXJuIGlzRXJyb3Iob2JqKTtcbn1cblxuZnVuY3Rpb24gc3ViRXJyb3IobmFtZVByb3BlcnR5LCBkZWZhdWx0TWVzc2FnZSkge1xuICAgIGZ1bmN0aW9uIFN1YkVycm9yKG1lc3NhZ2UpIHtcbiAgICAgICAgaWYgKCEodGhpcyBpbnN0YW5jZW9mIFN1YkVycm9yKSkgcmV0dXJuIG5ldyBTdWJFcnJvcihtZXNzYWdlKTtcbiAgICAgICAgdGhpcy5tZXNzYWdlID0gdHlwZW9mIG1lc3NhZ2UgPT09IFwic3RyaW5nXCIgPyBtZXNzYWdlIDogZGVmYXVsdE1lc3NhZ2U7XG4gICAgICAgIHRoaXMubmFtZSA9IG5hbWVQcm9wZXJ0eTtcbiAgICAgICAgaWYgKEVycm9yLmNhcHR1cmVTdGFja1RyYWNlKSB7XG4gICAgICAgICAgICBFcnJvci5jYXB0dXJlU3RhY2tUcmFjZSh0aGlzLCB0aGlzLmNvbnN0cnVjdG9yKTtcbiAgICAgICAgfVxuICAgIH1cbiAgICBpbmhlcml0cyhTdWJFcnJvciwgRXJyb3IpO1xuICAgIHJldHVybiBTdWJFcnJvcjtcbn1cblxudmFyIF9UeXBlRXJyb3IsIF9SYW5nZUVycm9yO1xudmFyIENhbmNlbGxhdGlvbkVycm9yID0gc3ViRXJyb3IoXCJDYW5jZWxsYXRpb25FcnJvclwiLCBcImNhbmNlbGxhdGlvbiBlcnJvclwiKTtcbnZhciBUaW1lb3V0RXJyb3IgPSBzdWJFcnJvcihcIlRpbWVvdXRFcnJvclwiLCBcInRpbWVvdXQgZXJyb3JcIik7XG52YXIgQWdncmVnYXRlRXJyb3IgPSBzdWJFcnJvcihcIkFnZ3JlZ2F0ZUVycm9yXCIsIFwiYWdncmVnYXRlIGVycm9yXCIpO1xudHJ5IHtcbiAgICBfVHlwZUVycm9yID0gVHlwZUVycm9yO1xuICAgIF9SYW5nZUVycm9yID0gUmFuZ2VFcnJvcjtcbn0gY2F0Y2goZSkge1xuICAgIF9UeXBlRXJyb3IgPSBzdWJFcnJvcihcIlR5cGVFcnJvclwiLCBcInR5cGUgZXJyb3JcIik7XG4gICAgX1JhbmdlRXJyb3IgPSBzdWJFcnJvcihcIlJhbmdlRXJyb3JcIiwgXCJyYW5nZSBlcnJvclwiKTtcbn1cblxudmFyIG1ldGhvZHMgPSAoXCJqb2luIHBvcCBwdXNoIHNoaWZ0IHVuc2hpZnQgc2xpY2UgZmlsdGVyIGZvckVhY2ggc29tZSBcIiArXG4gICAgXCJldmVyeSBtYXAgaW5kZXhPZiBsYXN0SW5kZXhPZiByZWR1Y2UgcmVkdWNlUmlnaHQgc29ydCByZXZlcnNlXCIpLnNwbGl0KFwiIFwiKTtcblxuZm9yICh2YXIgaSA9IDA7IGkgPCBtZXRob2RzLmxlbmd0aDsgKytpKSB7XG4gICAgaWYgKHR5cGVvZiBBcnJheS5wcm90b3R5cGVbbWV0aG9kc1tpXV0gPT09IFwiZnVuY3Rpb25cIikge1xuICAgICAgICBBZ2dyZWdhdGVFcnJvci5wcm90b3R5cGVbbWV0aG9kc1tpXV0gPSBBcnJheS5wcm90b3R5cGVbbWV0aG9kc1tpXV07XG4gICAgfVxufVxuXG5BZ2dyZWdhdGVFcnJvci5wcm90b3R5cGUubGVuZ3RoID0gMDtcbkFnZ3JlZ2F0ZUVycm9yLnByb3RvdHlwZVtcImlzT3BlcmF0aW9uYWxcIl0gPSB0cnVlO1xudmFyIGxldmVsID0gMDtcbkFnZ3JlZ2F0ZUVycm9yLnByb3RvdHlwZS50b1N0cmluZyA9IGZ1bmN0aW9uKCkge1xuICAgIHZhciBpbmRlbnQgPSBBcnJheShsZXZlbCAqIDQgKyAxKS5qb2luKFwiIFwiKTtcbiAgICB2YXIgcmV0ID0gXCJcXG5cIiArIGluZGVudCArIFwiQWdncmVnYXRlRXJyb3Igb2Y6XCIgKyBcIlxcblwiO1xuICAgIGxldmVsKys7XG4gICAgaW5kZW50ID0gQXJyYXkobGV2ZWwgKiA0ICsgMSkuam9pbihcIiBcIik7XG4gICAgZm9yICh2YXIgaSA9IDA7IGkgPCB0aGlzLmxlbmd0aDsgKytpKSB7XG4gICAgICAgIHZhciBzdHIgPSB0aGlzW2ldID09PSB0aGlzID8gXCJbQ2lyY3VsYXIgQWdncmVnYXRlRXJyb3JdXCIgOiB0aGlzW2ldICsgXCJcIjtcbiAgICAgICAgdmFyIGxpbmVzID0gc3RyLnNwbGl0KFwiXFxuXCIpO1xuICAgICAgICBmb3IgKHZhciBqID0gMDsgaiA8IGxpbmVzLmxlbmd0aDsgKytqKSB7XG4gICAgICAgICAgICBsaW5lc1tqXSA9IGluZGVudCArIGxpbmVzW2pdO1xuICAgICAgICB9XG4gICAgICAgIHN0ciA9IGxpbmVzLmpvaW4oXCJcXG5cIik7XG4gICAgICAgIHJldCArPSBzdHIgKyBcIlxcblwiO1xuICAgIH1cbiAgICBsZXZlbC0tO1xuICAgIHJldHVybiByZXQ7XG59O1xuXG5mdW5jdGlvbiBPcGVyYXRpb25hbEVycm9yKG1lc3NhZ2UpIHtcbiAgICB0aGlzLm5hbWUgPSBcIk9wZXJhdGlvbmFsRXJyb3JcIjtcbiAgICB0aGlzLm1lc3NhZ2UgPSBtZXNzYWdlO1xuICAgIHRoaXMuY2F1c2UgPSBtZXNzYWdlO1xuICAgIHRoaXNbXCJpc09wZXJhdGlvbmFsXCJdID0gdHJ1ZTtcblxuICAgIGlmIChtZXNzYWdlIGluc3RhbmNlb2YgRXJyb3IpIHtcbiAgICAgICAgdGhpcy5tZXNzYWdlID0gbWVzc2FnZS5tZXNzYWdlO1xuICAgICAgICB0aGlzLnN0YWNrID0gbWVzc2FnZS5zdGFjaztcbiAgICB9IGVsc2UgaWYgKEVycm9yLmNhcHR1cmVTdGFja1RyYWNlKSB7XG4gICAgICAgIEVycm9yLmNhcHR1cmVTdGFja1RyYWNlKHRoaXMsIHRoaXMuY29uc3RydWN0b3IpO1xuICAgIH1cblxufVxuaW5oZXJpdHMoT3BlcmF0aW9uYWxFcnJvciwgRXJyb3IpO1xuXG52YXIga2V5ID0gXCJfX0JsdWViaXJkRXJyb3JUeXBlc19fXCI7XG52YXIgZXJyb3JUeXBlcyA9IEVycm9yW2tleV07XG5pZiAoIWVycm9yVHlwZXMpIHtcbiAgICBlcnJvclR5cGVzID0gT2JqZWN0ZnJlZXplKHtcbiAgICAgICAgQ2FuY2VsbGF0aW9uRXJyb3I6IENhbmNlbGxhdGlvbkVycm9yLFxuICAgICAgICBUaW1lb3V0RXJyb3I6IFRpbWVvdXRFcnJvcixcbiAgICAgICAgT3BlcmF0aW9uYWxFcnJvcjogT3BlcmF0aW9uYWxFcnJvcixcbiAgICAgICAgUmVqZWN0aW9uRXJyb3I6IE9wZXJhdGlvbmFsRXJyb3IsXG4gICAgICAgIEFnZ3JlZ2F0ZUVycm9yOiBBZ2dyZWdhdGVFcnJvclxuICAgIH0pO1xuICAgIG5vdEVudW1lcmFibGVQcm9wKEVycm9yLCBrZXksIGVycm9yVHlwZXMpO1xufVxuXG5tb2R1bGUuZXhwb3J0cyA9IHtcbiAgICBFcnJvcjogRXJyb3IsXG4gICAgVHlwZUVycm9yOiBfVHlwZUVycm9yLFxuICAgIFJhbmdlRXJyb3I6IF9SYW5nZUVycm9yLFxuICAgIENhbmNlbGxhdGlvbkVycm9yOiBlcnJvclR5cGVzLkNhbmNlbGxhdGlvbkVycm9yLFxuICAgIE9wZXJhdGlvbmFsRXJyb3I6IGVycm9yVHlwZXMuT3BlcmF0aW9uYWxFcnJvcixcbiAgICBUaW1lb3V0RXJyb3I6IGVycm9yVHlwZXMuVGltZW91dEVycm9yLFxuICAgIEFnZ3JlZ2F0ZUVycm9yOiBlcnJvclR5cGVzLkFnZ3JlZ2F0ZUVycm9yLFxuICAgIG9yaWdpbmF0ZXNGcm9tUmVqZWN0aW9uOiBvcmlnaW5hdGVzRnJvbVJlamVjdGlvbixcbiAgICBtYXJrQXNPcmlnaW5hdGluZ0Zyb21SZWplY3Rpb246IG1hcmtBc09yaWdpbmF0aW5nRnJvbVJlamVjdGlvbixcbiAgICBjYW5BdHRhY2g6IGNhbkF0dGFjaFxufTtcbiIsIi8qKlxuICogVGhlIE1JVCBMaWNlbnNlIChNSVQpXG4gKiBcbiAqIENvcHlyaWdodCAoYykgMjAxNCBQZXRrYSBBbnRvbm92XG4gKiBcbiAqIFBlcm1pc3Npb24gaXMgaGVyZWJ5IGdyYW50ZWQsIGZyZWUgb2YgY2hhcmdlLCB0byBhbnkgcGVyc29uIG9idGFpbmluZyBhIGNvcHlcbiAqIG9mIHRoaXMgc29mdHdhcmUgYW5kIGFzc29jaWF0ZWQgZG9jdW1lbnRhdGlvbiBmaWxlcyAodGhlIFwiU29mdHdhcmVcIiksIHRvIGRlYWxcbiAqIGluIHRoZSBTb2Z0d2FyZSB3aXRob3V0IHJlc3RyaWN0aW9uLCBpbmNsdWRpbmcgd2l0aG91dCBsaW1pdGF0aW9uIHRoZSByaWdodHNcbiAqIHRvIHVzZSwgY29weSwgbW9kaWZ5LCBtZXJnZSwgcHVibGlzaCwgZGlzdHJpYnV0ZSwgc3VibGljZW5zZSwgYW5kL29yIHNlbGxcbiAqIGNvcGllcyBvZiB0aGUgU29mdHdhcmUsIGFuZCB0byBwZXJtaXQgcGVyc29ucyB0byB3aG9tIHRoZSBTb2Z0d2FyZSBpc1xuICogZnVybmlzaGVkIHRvIGRvIHNvLCBzdWJqZWN0IHRvIHRoZSBmb2xsb3dpbmcgY29uZGl0aW9uczo8L3A+XG4gKiBcbiAqIFRoZSBhYm92ZSBjb3B5cmlnaHQgbm90aWNlIGFuZCB0aGlzIHBlcm1pc3Npb24gbm90aWNlIHNoYWxsIGJlIGluY2x1ZGVkIGluXG4gKiBhbGwgY29waWVzIG9yIHN1YnN0YW50aWFsIHBvcnRpb25zIG9mIHRoZSBTb2Z0d2FyZS5cbiAqIFxuICogVEhFIFNPRlRXQVJFIElTIFBST1ZJREVEIFwiQVMgSVNcIiwgV0lUSE9VVCBXQVJSQU5UWSBPRiBBTlkgS0lORCwgRVhQUkVTUyBPUlxuICogSU1QTElFRCwgSU5DTFVESU5HIEJVVCBOT1QgTElNSVRFRCBUTyBUSEUgV0FSUkFOVElFUyBPRiBNRVJDSEFOVEFCSUxJVFksXG4gKiBGSVRORVNTIEZPUiBBIFBBUlRJQ1VMQVIgUFVSUE9TRSBBTkQgTk9OSU5GUklOR0VNRU5ULiAgSU4gTk8gRVZFTlQgU0hBTEwgVEhFXG4gKiBBVVRIT1JTIE9SIENPUFlSSUdIVCBIT0xERVJTIEJFIExJQUJMRSBGT1IgQU5ZIENMQUlNLCBEQU1BR0VTIE9SIE9USEVSXG4gKiBMSUFCSUxJVFksIFdIRVRIRVIgSU4gQU4gQUNUSU9OIE9GIENPTlRSQUNULCBUT1JUIE9SIE9USEVSV0lTRSwgQVJJU0lORyBGUk9NLFxuICogT1VUIE9GIE9SIElOIENPTk5FQ1RJT04gV0lUSCBUSEUgU09GVFdBUkUgT1IgVEhFIFVTRSBPUiBPVEhFUiBERUFMSU5HUyBJTlxuICogVEhFIFNPRlRXQVJFLlxuICogXG4gKi9cblwidXNlIHN0cmljdFwiO1xubW9kdWxlLmV4cG9ydHMgPSBmdW5jdGlvbihQcm9taXNlKSB7XG52YXIgVHlwZUVycm9yID0gcmVxdWlyZSgnLi9lcnJvcnMuanMnKS5UeXBlRXJyb3I7XG5cbmZ1bmN0aW9uIGFwaVJlamVjdGlvbihtc2cpIHtcbiAgICB2YXIgZXJyb3IgPSBuZXcgVHlwZUVycm9yKG1zZyk7XG4gICAgdmFyIHJldCA9IFByb21pc2UucmVqZWN0ZWQoZXJyb3IpO1xuICAgIHZhciBwYXJlbnQgPSByZXQuX3BlZWtDb250ZXh0KCk7XG4gICAgaWYgKHBhcmVudCAhPSBudWxsKSB7XG4gICAgICAgIHBhcmVudC5fYXR0YWNoRXh0cmFUcmFjZShlcnJvcik7XG4gICAgfVxuICAgIHJldHVybiByZXQ7XG59XG5cbnJldHVybiBhcGlSZWplY3Rpb247XG59O1xuIiwiLyoqXG4gKiBUaGUgTUlUIExpY2Vuc2UgKE1JVClcbiAqIFxuICogQ29weXJpZ2h0IChjKSAyMDE0IFBldGthIEFudG9ub3ZcbiAqIFxuICogUGVybWlzc2lvbiBpcyBoZXJlYnkgZ3JhbnRlZCwgZnJlZSBvZiBjaGFyZ2UsIHRvIGFueSBwZXJzb24gb2J0YWluaW5nIGEgY29weVxuICogb2YgdGhpcyBzb2Z0d2FyZSBhbmQgYXNzb2NpYXRlZCBkb2N1bWVudGF0aW9uIGZpbGVzICh0aGUgXCJTb2Z0d2FyZVwiKSwgdG8gZGVhbFxuICogaW4gdGhlIFNvZnR3YXJlIHdpdGhvdXQgcmVzdHJpY3Rpb24sIGluY2x1ZGluZyB3aXRob3V0IGxpbWl0YXRpb24gdGhlIHJpZ2h0c1xuICogdG8gdXNlLCBjb3B5LCBtb2RpZnksIG1lcmdlLCBwdWJsaXNoLCBkaXN0cmlidXRlLCBzdWJsaWNlbnNlLCBhbmQvb3Igc2VsbFxuICogY29waWVzIG9mIHRoZSBTb2Z0d2FyZSwgYW5kIHRvIHBlcm1pdCBwZXJzb25zIHRvIHdob20gdGhlIFNvZnR3YXJlIGlzXG4gKiBmdXJuaXNoZWQgdG8gZG8gc28sIHN1YmplY3QgdG8gdGhlIGZvbGxvd2luZyBjb25kaXRpb25zOjwvcD5cbiAqIFxuICogVGhlIGFib3ZlIGNvcHlyaWdodCBub3RpY2UgYW5kIHRoaXMgcGVybWlzc2lvbiBub3RpY2Ugc2hhbGwgYmUgaW5jbHVkZWQgaW5cbiAqIGFsbCBjb3BpZXMgb3Igc3Vic3RhbnRpYWwgcG9ydGlvbnMgb2YgdGhlIFNvZnR3YXJlLlxuICogXG4gKiBUSEUgU09GVFdBUkUgSVMgUFJPVklERUQgXCJBUyBJU1wiLCBXSVRIT1VUIFdBUlJBTlRZIE9GIEFOWSBLSU5ELCBFWFBSRVNTIE9SXG4gKiBJTVBMSUVELCBJTkNMVURJTkcgQlVUIE5PVCBMSU1JVEVEIFRPIFRIRSBXQVJSQU5USUVTIE9GIE1FUkNIQU5UQUJJTElUWSxcbiAqIEZJVE5FU1MgRk9SIEEgUEFSVElDVUxBUiBQVVJQT1NFIEFORCBOT05JTkZSSU5HRU1FTlQuICBJTiBOTyBFVkVOVCBTSEFMTCBUSEVcbiAqIEFVVEhPUlMgT1IgQ09QWVJJR0hUIEhPTERFUlMgQkUgTElBQkxFIEZPUiBBTlkgQ0xBSU0sIERBTUFHRVMgT1IgT1RIRVJcbiAqIExJQUJJTElUWSwgV0hFVEhFUiBJTiBBTiBBQ1RJT04gT0YgQ09OVFJBQ1QsIFRPUlQgT1IgT1RIRVJXSVNFLCBBUklTSU5HIEZST00sXG4gKiBPVVQgT0YgT1IgSU4gQ09OTkVDVElPTiBXSVRIIFRIRSBTT0ZUV0FSRSBPUiBUSEUgVVNFIE9SIE9USEVSIERFQUxJTkdTIElOXG4gKiBUSEUgU09GVFdBUkUuXG4gKiBcbiAqL1xudmFyIGlzRVM1ID0gKGZ1bmN0aW9uKCl7XG4gICAgXCJ1c2Ugc3RyaWN0XCI7XG4gICAgcmV0dXJuIHRoaXMgPT09IHZvaWQgMDtcbn0pKCk7XG5cbmlmIChpc0VTNSkge1xuICAgIG1vZHVsZS5leHBvcnRzID0ge1xuICAgICAgICBmcmVlemU6IE9iamVjdC5mcmVlemUsXG4gICAgICAgIGRlZmluZVByb3BlcnR5OiBPYmplY3QuZGVmaW5lUHJvcGVydHksXG4gICAgICAgIGtleXM6IE9iamVjdC5rZXlzLFxuICAgICAgICBnZXRQcm90b3R5cGVPZjogT2JqZWN0LmdldFByb3RvdHlwZU9mLFxuICAgICAgICBpc0FycmF5OiBBcnJheS5pc0FycmF5LFxuICAgICAgICBpc0VTNTogaXNFUzVcbiAgICB9O1xufSBlbHNlIHtcbiAgICB2YXIgaGFzID0ge30uaGFzT3duUHJvcGVydHk7XG4gICAgdmFyIHN0ciA9IHt9LnRvU3RyaW5nO1xuICAgIHZhciBwcm90byA9IHt9LmNvbnN0cnVjdG9yLnByb3RvdHlwZTtcblxuICAgIHZhciBPYmplY3RLZXlzID0gZnVuY3Rpb24gT2JqZWN0S2V5cyhvKSB7XG4gICAgICAgIHZhciByZXQgPSBbXTtcbiAgICAgICAgZm9yICh2YXIga2V5IGluIG8pIHtcbiAgICAgICAgICAgIGlmIChoYXMuY2FsbChvLCBrZXkpKSB7XG4gICAgICAgICAgICAgICAgcmV0LnB1c2goa2V5KTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gcmV0O1xuICAgIH1cblxuICAgIHZhciBPYmplY3REZWZpbmVQcm9wZXJ0eSA9IGZ1bmN0aW9uIE9iamVjdERlZmluZVByb3BlcnR5KG8sIGtleSwgZGVzYykge1xuICAgICAgICBvW2tleV0gPSBkZXNjLnZhbHVlO1xuICAgICAgICByZXR1cm4gbztcbiAgICB9XG5cbiAgICB2YXIgT2JqZWN0RnJlZXplID0gZnVuY3Rpb24gT2JqZWN0RnJlZXplKG9iaikge1xuICAgICAgICByZXR1cm4gb2JqO1xuICAgIH1cblxuICAgIHZhciBPYmplY3RHZXRQcm90b3R5cGVPZiA9IGZ1bmN0aW9uIE9iamVjdEdldFByb3RvdHlwZU9mKG9iaikge1xuICAgICAgICB0cnkge1xuICAgICAgICAgICAgcmV0dXJuIE9iamVjdChvYmopLmNvbnN0cnVjdG9yLnByb3RvdHlwZTtcbiAgICAgICAgfVxuICAgICAgICBjYXRjaCAoZSkge1xuICAgICAgICAgICAgcmV0dXJuIHByb3RvO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgdmFyIEFycmF5SXNBcnJheSA9IGZ1bmN0aW9uIEFycmF5SXNBcnJheShvYmopIHtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIHJldHVybiBzdHIuY2FsbChvYmopID09PSBcIltvYmplY3QgQXJyYXldXCI7XG4gICAgICAgIH1cbiAgICAgICAgY2F0Y2goZSkge1xuICAgICAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgbW9kdWxlLmV4cG9ydHMgPSB7XG4gICAgICAgIGlzQXJyYXk6IEFycmF5SXNBcnJheSxcbiAgICAgICAga2V5czogT2JqZWN0S2V5cyxcbiAgICAgICAgZGVmaW5lUHJvcGVydHk6IE9iamVjdERlZmluZVByb3BlcnR5LFxuICAgICAgICBmcmVlemU6IE9iamVjdEZyZWV6ZSxcbiAgICAgICAgZ2V0UHJvdG90eXBlT2Y6IE9iamVjdEdldFByb3RvdHlwZU9mLFxuICAgICAgICBpc0VTNTogaXNFUzVcbiAgICB9O1xufVxuIiwiLyoqXG4gKiBUaGUgTUlUIExpY2Vuc2UgKE1JVClcbiAqIFxuICogQ29weXJpZ2h0IChjKSAyMDE0IFBldGthIEFudG9ub3ZcbiAqIFxuICogUGVybWlzc2lvbiBpcyBoZXJlYnkgZ3JhbnRlZCwgZnJlZSBvZiBjaGFyZ2UsIHRvIGFueSBwZXJzb24gb2J0YWluaW5nIGEgY29weVxuICogb2YgdGhpcyBzb2Z0d2FyZSBhbmQgYXNzb2NpYXRlZCBkb2N1bWVudGF0aW9uIGZpbGVzICh0aGUgXCJTb2Z0d2FyZVwiKSwgdG8gZGVhbFxuICogaW4gdGhlIFNvZnR3YXJlIHdpdGhvdXQgcmVzdHJpY3Rpb24sIGluY2x1ZGluZyB3aXRob3V0IGxpbWl0YXRpb24gdGhlIHJpZ2h0c1xuICogdG8gdXNlLCBjb3B5LCBtb2RpZnksIG1lcmdlLCBwdWJsaXNoLCBkaXN0cmlidXRlLCBzdWJsaWNlbnNlLCBhbmQvb3Igc2VsbFxuICogY29waWVzIG9mIHRoZSBTb2Z0d2FyZSwgYW5kIHRvIHBlcm1pdCBwZXJzb25zIHRvIHdob20gdGhlIFNvZnR3YXJlIGlzXG4gKiBmdXJuaXNoZWQgdG8gZG8gc28sIHN1YmplY3QgdG8gdGhlIGZvbGxvd2luZyBjb25kaXRpb25zOjwvcD5cbiAqIFxuICogVGhlIGFib3ZlIGNvcHlyaWdodCBub3RpY2UgYW5kIHRoaXMgcGVybWlzc2lvbiBub3RpY2Ugc2hhbGwgYmUgaW5jbHVkZWQgaW5cbiAqIGFsbCBjb3BpZXMgb3Igc3Vic3RhbnRpYWwgcG9ydGlvbnMgb2YgdGhlIFNvZnR3YXJlLlxuICogXG4gKiBUSEUgU09GVFdBUkUgSVMgUFJPVklERUQgXCJBUyBJU1wiLCBXSVRIT1VUIFdBUlJBTlRZIE9GIEFOWSBLSU5ELCBFWFBSRVNTIE9SXG4gKiBJTVBMSUVELCBJTkNMVURJTkcgQlVUIE5PVCBMSU1JVEVEIFRPIFRIRSBXQVJSQU5USUVTIE9GIE1FUkNIQU5UQUJJTElUWSxcbiAqIEZJVE5FU1MgRk9SIEEgUEFSVElDVUxBUiBQVVJQT1NFIEFORCBOT05JTkZSSU5HRU1FTlQuICBJTiBOTyBFVkVOVCBTSEFMTCBUSEVcbiAqIEFVVEhPUlMgT1IgQ09QWVJJR0hUIEhPTERFUlMgQkUgTElBQkxFIEZPUiBBTlkgQ0xBSU0sIERBTUFHRVMgT1IgT1RIRVJcbiAqIExJQUJJTElUWSwgV0hFVEhFUiBJTiBBTiBBQ1RJT04gT0YgQ09OVFJBQ1QsIFRPUlQgT1IgT1RIRVJXSVNFLCBBUklTSU5HIEZST00sXG4gKiBPVVQgT0YgT1IgSU4gQ09OTkVDVElPTiBXSVRIIFRIRSBTT0ZUV0FSRSBPUiBUSEUgVVNFIE9SIE9USEVSIERFQUxJTkdTIElOXG4gKiBUSEUgU09GVFdBUkUuXG4gKiBcbiAqL1xuXCJ1c2Ugc3RyaWN0XCI7XG5tb2R1bGUuZXhwb3J0cyA9IGZ1bmN0aW9uKFByb21pc2UsIElOVEVSTkFMKSB7XG52YXIgUHJvbWlzZU1hcCA9IFByb21pc2UubWFwO1xuXG5Qcm9taXNlLnByb3RvdHlwZS5maWx0ZXIgPSBmdW5jdGlvbiBQcm9taXNlJGZpbHRlcihmbiwgb3B0aW9ucykge1xuICAgIHJldHVybiBQcm9taXNlTWFwKHRoaXMsIGZuLCBvcHRpb25zLCBJTlRFUk5BTCk7XG59O1xuXG5Qcm9taXNlLmZpbHRlciA9IGZ1bmN0aW9uIFByb21pc2UkRmlsdGVyKHByb21pc2VzLCBmbiwgb3B0aW9ucykge1xuICAgIHJldHVybiBQcm9taXNlTWFwKHByb21pc2VzLCBmbiwgb3B0aW9ucywgSU5URVJOQUwpO1xufTtcbn07XG4iLCIvKipcbiAqIFRoZSBNSVQgTGljZW5zZSAoTUlUKVxuICogXG4gKiBDb3B5cmlnaHQgKGMpIDIwMTQgUGV0a2EgQW50b25vdlxuICogXG4gKiBQZXJtaXNzaW9uIGlzIGhlcmVieSBncmFudGVkLCBmcmVlIG9mIGNoYXJnZSwgdG8gYW55IHBlcnNvbiBvYnRhaW5pbmcgYSBjb3B5XG4gKiBvZiB0aGlzIHNvZnR3YXJlIGFuZCBhc3NvY2lhdGVkIGRvY3VtZW50YXRpb24gZmlsZXMgKHRoZSBcIlNvZnR3YXJlXCIpLCB0byBkZWFsXG4gKiBpbiB0aGUgU29mdHdhcmUgd2l0aG91dCByZXN0cmljdGlvbiwgaW5jbHVkaW5nIHdpdGhvdXQgbGltaXRhdGlvbiB0aGUgcmlnaHRzXG4gKiB0byB1c2UsIGNvcHksIG1vZGlmeSwgbWVyZ2UsIHB1Ymxpc2gsIGRpc3RyaWJ1dGUsIHN1YmxpY2Vuc2UsIGFuZC9vciBzZWxsXG4gKiBjb3BpZXMgb2YgdGhlIFNvZnR3YXJlLCBhbmQgdG8gcGVybWl0IHBlcnNvbnMgdG8gd2hvbSB0aGUgU29mdHdhcmUgaXNcbiAqIGZ1cm5pc2hlZCB0byBkbyBzbywgc3ViamVjdCB0byB0aGUgZm9sbG93aW5nIGNvbmRpdGlvbnM6PC9wPlxuICogXG4gKiBUaGUgYWJvdmUgY29weXJpZ2h0IG5vdGljZSBhbmQgdGhpcyBwZXJtaXNzaW9uIG5vdGljZSBzaGFsbCBiZSBpbmNsdWRlZCBpblxuICogYWxsIGNvcGllcyBvciBzdWJzdGFudGlhbCBwb3J0aW9ucyBvZiB0aGUgU29mdHdhcmUuXG4gKiBcbiAqIFRIRSBTT0ZUV0FSRSBJUyBQUk9WSURFRCBcIkFTIElTXCIsIFdJVEhPVVQgV0FSUkFOVFkgT0YgQU5ZIEtJTkQsIEVYUFJFU1MgT1JcbiAqIElNUExJRUQsIElOQ0xVRElORyBCVVQgTk9UIExJTUlURUQgVE8gVEhFIFdBUlJBTlRJRVMgT0YgTUVSQ0hBTlRBQklMSVRZLFxuICogRklUTkVTUyBGT1IgQSBQQVJUSUNVTEFSIFBVUlBPU0UgQU5EIE5PTklORlJJTkdFTUVOVC4gIElOIE5PIEVWRU5UIFNIQUxMIFRIRVxuICogQVVUSE9SUyBPUiBDT1BZUklHSFQgSE9MREVSUyBCRSBMSUFCTEUgRk9SIEFOWSBDTEFJTSwgREFNQUdFUyBPUiBPVEhFUlxuICogTElBQklMSVRZLCBXSEVUSEVSIElOIEFOIEFDVElPTiBPRiBDT05UUkFDVCwgVE9SVCBPUiBPVEhFUldJU0UsIEFSSVNJTkcgRlJPTSxcbiAqIE9VVCBPRiBPUiBJTiBDT05ORUNUSU9OIFdJVEggVEhFIFNPRlRXQVJFIE9SIFRIRSBVU0UgT1IgT1RIRVIgREVBTElOR1MgSU5cbiAqIFRIRSBTT0ZUV0FSRS5cbiAqIFxuICovXG5cInVzZSBzdHJpY3RcIjtcbm1vZHVsZS5leHBvcnRzID0gZnVuY3Rpb24oUHJvbWlzZSwgTkVYVF9GSUxURVIsIGNhc3QpIHtcbnZhciB1dGlsID0gcmVxdWlyZShcIi4vdXRpbC5qc1wiKTtcbnZhciB3cmFwc1ByaW1pdGl2ZVJlY2VpdmVyID0gdXRpbC53cmFwc1ByaW1pdGl2ZVJlY2VpdmVyO1xudmFyIGlzUHJpbWl0aXZlID0gdXRpbC5pc1ByaW1pdGl2ZTtcbnZhciB0aHJvd2VyID0gdXRpbC50aHJvd2VyO1xuXG5mdW5jdGlvbiByZXR1cm5UaGlzKCkge1xuICAgIHJldHVybiB0aGlzO1xufVxuZnVuY3Rpb24gdGhyb3dUaGlzKCkge1xuICAgIHRocm93IHRoaXM7XG59XG5mdW5jdGlvbiByZXR1cm4kKHIpIHtcbiAgICByZXR1cm4gZnVuY3Rpb24gUHJvbWlzZSRfcmV0dXJuZXIoKSB7XG4gICAgICAgIHJldHVybiByO1xuICAgIH07XG59XG5mdW5jdGlvbiB0aHJvdyQocikge1xuICAgIHJldHVybiBmdW5jdGlvbiBQcm9taXNlJF90aHJvd2VyKCkge1xuICAgICAgICB0aHJvdyByO1xuICAgIH07XG59XG5mdW5jdGlvbiBwcm9taXNlZEZpbmFsbHkocmV0LCByZWFzb25PclZhbHVlLCBpc0Z1bGZpbGxlZCkge1xuICAgIHZhciB0aGVuO1xuICAgIGlmICh3cmFwc1ByaW1pdGl2ZVJlY2VpdmVyICYmIGlzUHJpbWl0aXZlKHJlYXNvbk9yVmFsdWUpKSB7XG4gICAgICAgIHRoZW4gPSBpc0Z1bGZpbGxlZCA/IHJldHVybiQocmVhc29uT3JWYWx1ZSkgOiB0aHJvdyQocmVhc29uT3JWYWx1ZSk7XG4gICAgfSBlbHNlIHtcbiAgICAgICAgdGhlbiA9IGlzRnVsZmlsbGVkID8gcmV0dXJuVGhpcyA6IHRocm93VGhpcztcbiAgICB9XG4gICAgcmV0dXJuIHJldC5fdGhlbih0aGVuLCB0aHJvd2VyLCB2b2lkIDAsIHJlYXNvbk9yVmFsdWUsIHZvaWQgMCk7XG59XG5cbmZ1bmN0aW9uIGZpbmFsbHlIYW5kbGVyKHJlYXNvbk9yVmFsdWUpIHtcbiAgICB2YXIgcHJvbWlzZSA9IHRoaXMucHJvbWlzZTtcbiAgICB2YXIgaGFuZGxlciA9IHRoaXMuaGFuZGxlcjtcblxuICAgIHZhciByZXQgPSBwcm9taXNlLl9pc0JvdW5kKClcbiAgICAgICAgICAgICAgICAgICAgPyBoYW5kbGVyLmNhbGwocHJvbWlzZS5fYm91bmRUbylcbiAgICAgICAgICAgICAgICAgICAgOiBoYW5kbGVyKCk7XG5cbiAgICBpZiAocmV0ICE9PSB2b2lkIDApIHtcbiAgICAgICAgdmFyIG1heWJlUHJvbWlzZSA9IGNhc3QocmV0LCB2b2lkIDApO1xuICAgICAgICBpZiAobWF5YmVQcm9taXNlIGluc3RhbmNlb2YgUHJvbWlzZSkge1xuICAgICAgICAgICAgcmV0dXJuIHByb21pc2VkRmluYWxseShtYXliZVByb21pc2UsIHJlYXNvbk9yVmFsdWUsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBwcm9taXNlLmlzRnVsZmlsbGVkKCkpO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgaWYgKHByb21pc2UuaXNSZWplY3RlZCgpKSB7XG4gICAgICAgIE5FWFRfRklMVEVSLmUgPSByZWFzb25PclZhbHVlO1xuICAgICAgICByZXR1cm4gTkVYVF9GSUxURVI7XG4gICAgfSBlbHNlIHtcbiAgICAgICAgcmV0dXJuIHJlYXNvbk9yVmFsdWU7XG4gICAgfVxufVxuXG5mdW5jdGlvbiB0YXBIYW5kbGVyKHZhbHVlKSB7XG4gICAgdmFyIHByb21pc2UgPSB0aGlzLnByb21pc2U7XG4gICAgdmFyIGhhbmRsZXIgPSB0aGlzLmhhbmRsZXI7XG5cbiAgICB2YXIgcmV0ID0gcHJvbWlzZS5faXNCb3VuZCgpXG4gICAgICAgICAgICAgICAgICAgID8gaGFuZGxlci5jYWxsKHByb21pc2UuX2JvdW5kVG8sIHZhbHVlKVxuICAgICAgICAgICAgICAgICAgICA6IGhhbmRsZXIodmFsdWUpO1xuXG4gICAgaWYgKHJldCAhPT0gdm9pZCAwKSB7XG4gICAgICAgIHZhciBtYXliZVByb21pc2UgPSBjYXN0KHJldCwgdm9pZCAwKTtcbiAgICAgICAgaWYgKG1heWJlUHJvbWlzZSBpbnN0YW5jZW9mIFByb21pc2UpIHtcbiAgICAgICAgICAgIHJldHVybiBwcm9taXNlZEZpbmFsbHkobWF5YmVQcm9taXNlLCB2YWx1ZSwgdHJ1ZSk7XG4gICAgICAgIH1cbiAgICB9XG4gICAgcmV0dXJuIHZhbHVlO1xufVxuXG5Qcm9taXNlLnByb3RvdHlwZS5fcGFzc1Rocm91Z2hIYW5kbGVyID1cbmZ1bmN0aW9uIFByb21pc2UkX3Bhc3NUaHJvdWdoSGFuZGxlcihoYW5kbGVyLCBpc0ZpbmFsbHkpIHtcbiAgICBpZiAodHlwZW9mIGhhbmRsZXIgIT09IFwiZnVuY3Rpb25cIikgcmV0dXJuIHRoaXMudGhlbigpO1xuXG4gICAgdmFyIHByb21pc2VBbmRIYW5kbGVyID0ge1xuICAgICAgICBwcm9taXNlOiB0aGlzLFxuICAgICAgICBoYW5kbGVyOiBoYW5kbGVyXG4gICAgfTtcblxuICAgIHJldHVybiB0aGlzLl90aGVuKFxuICAgICAgICAgICAgaXNGaW5hbGx5ID8gZmluYWxseUhhbmRsZXIgOiB0YXBIYW5kbGVyLFxuICAgICAgICAgICAgaXNGaW5hbGx5ID8gZmluYWxseUhhbmRsZXIgOiB2b2lkIDAsIHZvaWQgMCxcbiAgICAgICAgICAgIHByb21pc2VBbmRIYW5kbGVyLCB2b2lkIDApO1xufTtcblxuUHJvbWlzZS5wcm90b3R5cGUubGFzdGx5ID1cblByb21pc2UucHJvdG90eXBlW1wiZmluYWxseVwiXSA9IGZ1bmN0aW9uIFByb21pc2UkZmluYWxseShoYW5kbGVyKSB7XG4gICAgcmV0dXJuIHRoaXMuX3Bhc3NUaHJvdWdoSGFuZGxlcihoYW5kbGVyLCB0cnVlKTtcbn07XG5cblByb21pc2UucHJvdG90eXBlLnRhcCA9IGZ1bmN0aW9uIFByb21pc2UkdGFwKGhhbmRsZXIpIHtcbiAgICByZXR1cm4gdGhpcy5fcGFzc1Rocm91Z2hIYW5kbGVyKGhhbmRsZXIsIGZhbHNlKTtcbn07XG59O1xuIiwiLyoqXG4gKiBUaGUgTUlUIExpY2Vuc2UgKE1JVClcbiAqIFxuICogQ29weXJpZ2h0IChjKSAyMDE0IFBldGthIEFudG9ub3ZcbiAqIFxuICogUGVybWlzc2lvbiBpcyBoZXJlYnkgZ3JhbnRlZCwgZnJlZSBvZiBjaGFyZ2UsIHRvIGFueSBwZXJzb24gb2J0YWluaW5nIGEgY29weVxuICogb2YgdGhpcyBzb2Z0d2FyZSBhbmQgYXNzb2NpYXRlZCBkb2N1bWVudGF0aW9uIGZpbGVzICh0aGUgXCJTb2Z0d2FyZVwiKSwgdG8gZGVhbFxuICogaW4gdGhlIFNvZnR3YXJlIHdpdGhvdXQgcmVzdHJpY3Rpb24sIGluY2x1ZGluZyB3aXRob3V0IGxpbWl0YXRpb24gdGhlIHJpZ2h0c1xuICogdG8gdXNlLCBjb3B5LCBtb2RpZnksIG1lcmdlLCBwdWJsaXNoLCBkaXN0cmlidXRlLCBzdWJsaWNlbnNlLCBhbmQvb3Igc2VsbFxuICogY29waWVzIG9mIHRoZSBTb2Z0d2FyZSwgYW5kIHRvIHBlcm1pdCBwZXJzb25zIHRvIHdob20gdGhlIFNvZnR3YXJlIGlzXG4gKiBmdXJuaXNoZWQgdG8gZG8gc28sIHN1YmplY3QgdG8gdGhlIGZvbGxvd2luZyBjb25kaXRpb25zOjwvcD5cbiAqIFxuICogVGhlIGFib3ZlIGNvcHlyaWdodCBub3RpY2UgYW5kIHRoaXMgcGVybWlzc2lvbiBub3RpY2Ugc2hhbGwgYmUgaW5jbHVkZWQgaW5cbiAqIGFsbCBjb3BpZXMgb3Igc3Vic3RhbnRpYWwgcG9ydGlvbnMgb2YgdGhlIFNvZnR3YXJlLlxuICogXG4gKiBUSEUgU09GVFdBUkUgSVMgUFJPVklERUQgXCJBUyBJU1wiLCBXSVRIT1VUIFdBUlJBTlRZIE9GIEFOWSBLSU5ELCBFWFBSRVNTIE9SXG4gKiBJTVBMSUVELCBJTkNMVURJTkcgQlVUIE5PVCBMSU1JVEVEIFRPIFRIRSBXQVJSQU5USUVTIE9GIE1FUkNIQU5UQUJJTElUWSxcbiAqIEZJVE5FU1MgRk9SIEEgUEFSVElDVUxBUiBQVVJQT1NFIEFORCBOT05JTkZSSU5HRU1FTlQuICBJTiBOTyBFVkVOVCBTSEFMTCBUSEVcbiAqIEFVVEhPUlMgT1IgQ09QWVJJR0hUIEhPTERFUlMgQkUgTElBQkxFIEZPUiBBTlkgQ0xBSU0sIERBTUFHRVMgT1IgT1RIRVJcbiAqIExJQUJJTElUWSwgV0hFVEhFUiBJTiBBTiBBQ1RJT04gT0YgQ09OVFJBQ1QsIFRPUlQgT1IgT1RIRVJXSVNFLCBBUklTSU5HIEZST00sXG4gKiBPVVQgT0YgT1IgSU4gQ09OTkVDVElPTiBXSVRIIFRIRSBTT0ZUV0FSRSBPUiBUSEUgVVNFIE9SIE9USEVSIERFQUxJTkdTIElOXG4gKiBUSEUgU09GVFdBUkUuXG4gKiBcbiAqL1xuXCJ1c2Ugc3RyaWN0XCI7XG5tb2R1bGUuZXhwb3J0cyA9IGZ1bmN0aW9uKFByb21pc2UsIGFwaVJlamVjdGlvbiwgSU5URVJOQUwsIGNhc3QpIHtcbnZhciBlcnJvcnMgPSByZXF1aXJlKFwiLi9lcnJvcnMuanNcIik7XG52YXIgVHlwZUVycm9yID0gZXJyb3JzLlR5cGVFcnJvcjtcbnZhciBkZXByZWNhdGVkID0gcmVxdWlyZShcIi4vdXRpbC5qc1wiKS5kZXByZWNhdGVkO1xudmFyIHV0aWwgPSByZXF1aXJlKFwiLi91dGlsLmpzXCIpO1xudmFyIGVycm9yT2JqID0gdXRpbC5lcnJvck9iajtcbnZhciB0cnlDYXRjaDEgPSB1dGlsLnRyeUNhdGNoMTtcbnZhciB5aWVsZEhhbmRsZXJzID0gW107XG5cbmZ1bmN0aW9uIHByb21pc2VGcm9tWWllbGRIYW5kbGVyKHZhbHVlLCB5aWVsZEhhbmRsZXJzKSB7XG4gICAgdmFyIF9lcnJvck9iaiA9IGVycm9yT2JqO1xuICAgIHZhciBfUHJvbWlzZSA9IFByb21pc2U7XG4gICAgdmFyIGxlbiA9IHlpZWxkSGFuZGxlcnMubGVuZ3RoO1xuICAgIGZvciAodmFyIGkgPSAwOyBpIDwgbGVuOyArK2kpIHtcbiAgICAgICAgdmFyIHJlc3VsdCA9IHRyeUNhdGNoMSh5aWVsZEhhbmRsZXJzW2ldLCB2b2lkIDAsIHZhbHVlKTtcbiAgICAgICAgaWYgKHJlc3VsdCA9PT0gX2Vycm9yT2JqKSB7XG4gICAgICAgICAgICByZXR1cm4gX1Byb21pc2UucmVqZWN0KF9lcnJvck9iai5lKTtcbiAgICAgICAgfVxuICAgICAgICB2YXIgbWF5YmVQcm9taXNlID0gY2FzdChyZXN1bHQsIHByb21pc2VGcm9tWWllbGRIYW5kbGVyKTtcbiAgICAgICAgaWYgKG1heWJlUHJvbWlzZSBpbnN0YW5jZW9mIF9Qcm9taXNlKSByZXR1cm4gbWF5YmVQcm9taXNlO1xuICAgIH1cbiAgICByZXR1cm4gbnVsbDtcbn1cblxuZnVuY3Rpb24gUHJvbWlzZVNwYXduKGdlbmVyYXRvckZ1bmN0aW9uLCByZWNlaXZlciwgeWllbGRIYW5kbGVyKSB7XG4gICAgdmFyIHByb21pc2UgPSB0aGlzLl9wcm9taXNlID0gbmV3IFByb21pc2UoSU5URVJOQUwpO1xuICAgIHByb21pc2UuX3NldFRyYWNlKHZvaWQgMCk7XG4gICAgdGhpcy5fZ2VuZXJhdG9yRnVuY3Rpb24gPSBnZW5lcmF0b3JGdW5jdGlvbjtcbiAgICB0aGlzLl9yZWNlaXZlciA9IHJlY2VpdmVyO1xuICAgIHRoaXMuX2dlbmVyYXRvciA9IHZvaWQgMDtcbiAgICB0aGlzLl95aWVsZEhhbmRsZXJzID0gdHlwZW9mIHlpZWxkSGFuZGxlciA9PT0gXCJmdW5jdGlvblwiXG4gICAgICAgID8gW3lpZWxkSGFuZGxlcl0uY29uY2F0KHlpZWxkSGFuZGxlcnMpXG4gICAgICAgIDogeWllbGRIYW5kbGVycztcbn1cblxuUHJvbWlzZVNwYXduLnByb3RvdHlwZS5wcm9taXNlID0gZnVuY3Rpb24gUHJvbWlzZVNwYXduJHByb21pc2UoKSB7XG4gICAgcmV0dXJuIHRoaXMuX3Byb21pc2U7XG59O1xuXG5Qcm9taXNlU3Bhd24ucHJvdG90eXBlLl9ydW4gPSBmdW5jdGlvbiBQcm9taXNlU3Bhd24kX3J1bigpIHtcbiAgICB0aGlzLl9nZW5lcmF0b3IgPSB0aGlzLl9nZW5lcmF0b3JGdW5jdGlvbi5jYWxsKHRoaXMuX3JlY2VpdmVyKTtcbiAgICB0aGlzLl9yZWNlaXZlciA9XG4gICAgICAgIHRoaXMuX2dlbmVyYXRvckZ1bmN0aW9uID0gdm9pZCAwO1xuICAgIHRoaXMuX25leHQodm9pZCAwKTtcbn07XG5cblByb21pc2VTcGF3bi5wcm90b3R5cGUuX2NvbnRpbnVlID0gZnVuY3Rpb24gUHJvbWlzZVNwYXduJF9jb250aW51ZShyZXN1bHQpIHtcbiAgICBpZiAocmVzdWx0ID09PSBlcnJvck9iaikge1xuICAgICAgICB0aGlzLl9nZW5lcmF0b3IgPSB2b2lkIDA7XG4gICAgICAgIHZhciB0cmFjZSA9IGVycm9ycy5jYW5BdHRhY2gocmVzdWx0LmUpXG4gICAgICAgICAgICA/IHJlc3VsdC5lIDogbmV3IEVycm9yKHJlc3VsdC5lICsgXCJcIik7XG4gICAgICAgIHRoaXMuX3Byb21pc2UuX2F0dGFjaEV4dHJhVHJhY2UodHJhY2UpO1xuICAgICAgICB0aGlzLl9wcm9taXNlLl9yZWplY3QocmVzdWx0LmUsIHRyYWNlKTtcbiAgICAgICAgcmV0dXJuO1xuICAgIH1cblxuICAgIHZhciB2YWx1ZSA9IHJlc3VsdC52YWx1ZTtcbiAgICBpZiAocmVzdWx0LmRvbmUgPT09IHRydWUpIHtcbiAgICAgICAgdGhpcy5fZ2VuZXJhdG9yID0gdm9pZCAwO1xuICAgICAgICBpZiAoIXRoaXMuX3Byb21pc2UuX3RyeUZvbGxvdyh2YWx1ZSkpIHtcbiAgICAgICAgICAgIHRoaXMuX3Byb21pc2UuX2Z1bGZpbGwodmFsdWUpO1xuICAgICAgICB9XG4gICAgfSBlbHNlIHtcbiAgICAgICAgdmFyIG1heWJlUHJvbWlzZSA9IGNhc3QodmFsdWUsIHZvaWQgMCk7XG4gICAgICAgIGlmICghKG1heWJlUHJvbWlzZSBpbnN0YW5jZW9mIFByb21pc2UpKSB7XG4gICAgICAgICAgICBtYXliZVByb21pc2UgPVxuICAgICAgICAgICAgICAgIHByb21pc2VGcm9tWWllbGRIYW5kbGVyKG1heWJlUHJvbWlzZSwgdGhpcy5feWllbGRIYW5kbGVycyk7XG4gICAgICAgICAgICBpZiAobWF5YmVQcm9taXNlID09PSBudWxsKSB7XG4gICAgICAgICAgICAgICAgdGhpcy5fdGhyb3cobmV3IFR5cGVFcnJvcihcIkEgdmFsdWUgd2FzIHlpZWxkZWQgdGhhdCBjb3VsZCBub3QgYmUgdHJlYXRlZCBhcyBhIHByb21pc2VcIikpO1xuICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgICBtYXliZVByb21pc2UuX3RoZW4oXG4gICAgICAgICAgICB0aGlzLl9uZXh0LFxuICAgICAgICAgICAgdGhpcy5fdGhyb3csXG4gICAgICAgICAgICB2b2lkIDAsXG4gICAgICAgICAgICB0aGlzLFxuICAgICAgICAgICAgbnVsbFxuICAgICAgICk7XG4gICAgfVxufTtcblxuUHJvbWlzZVNwYXduLnByb3RvdHlwZS5fdGhyb3cgPSBmdW5jdGlvbiBQcm9taXNlU3Bhd24kX3Rocm93KHJlYXNvbikge1xuICAgIGlmIChlcnJvcnMuY2FuQXR0YWNoKHJlYXNvbikpXG4gICAgICAgIHRoaXMuX3Byb21pc2UuX2F0dGFjaEV4dHJhVHJhY2UocmVhc29uKTtcbiAgICB0aGlzLl9jb250aW51ZShcbiAgICAgICAgdHJ5Q2F0Y2gxKHRoaXMuX2dlbmVyYXRvcltcInRocm93XCJdLCB0aGlzLl9nZW5lcmF0b3IsIHJlYXNvbilcbiAgICk7XG59O1xuXG5Qcm9taXNlU3Bhd24ucHJvdG90eXBlLl9uZXh0ID0gZnVuY3Rpb24gUHJvbWlzZVNwYXduJF9uZXh0KHZhbHVlKSB7XG4gICAgdGhpcy5fY29udGludWUoXG4gICAgICAgIHRyeUNhdGNoMSh0aGlzLl9nZW5lcmF0b3IubmV4dCwgdGhpcy5fZ2VuZXJhdG9yLCB2YWx1ZSlcbiAgICk7XG59O1xuXG5Qcm9taXNlLmNvcm91dGluZSA9XG5mdW5jdGlvbiBQcm9taXNlJENvcm91dGluZShnZW5lcmF0b3JGdW5jdGlvbiwgb3B0aW9ucykge1xuICAgIGlmICh0eXBlb2YgZ2VuZXJhdG9yRnVuY3Rpb24gIT09IFwiZnVuY3Rpb25cIikge1xuICAgICAgICB0aHJvdyBuZXcgVHlwZUVycm9yKFwiZ2VuZXJhdG9yRnVuY3Rpb24gbXVzdCBiZSBhIGZ1bmN0aW9uXCIpO1xuICAgIH1cbiAgICB2YXIgeWllbGRIYW5kbGVyID0gT2JqZWN0KG9wdGlvbnMpLnlpZWxkSGFuZGxlcjtcbiAgICB2YXIgUHJvbWlzZVNwYXduJCA9IFByb21pc2VTcGF3bjtcbiAgICByZXR1cm4gZnVuY3Rpb24gKCkge1xuICAgICAgICB2YXIgZ2VuZXJhdG9yID0gZ2VuZXJhdG9yRnVuY3Rpb24uYXBwbHkodGhpcywgYXJndW1lbnRzKTtcbiAgICAgICAgdmFyIHNwYXduID0gbmV3IFByb21pc2VTcGF3biQodm9pZCAwLCB2b2lkIDAsIHlpZWxkSGFuZGxlcik7XG4gICAgICAgIHNwYXduLl9nZW5lcmF0b3IgPSBnZW5lcmF0b3I7XG4gICAgICAgIHNwYXduLl9uZXh0KHZvaWQgMCk7XG4gICAgICAgIHJldHVybiBzcGF3bi5wcm9taXNlKCk7XG4gICAgfTtcbn07XG5cblByb21pc2UuY29yb3V0aW5lLmFkZFlpZWxkSGFuZGxlciA9IGZ1bmN0aW9uKGZuKSB7XG4gICAgaWYgKHR5cGVvZiBmbiAhPT0gXCJmdW5jdGlvblwiKSB0aHJvdyBuZXcgVHlwZUVycm9yKFwiZm4gbXVzdCBiZSBhIGZ1bmN0aW9uXCIpO1xuICAgIHlpZWxkSGFuZGxlcnMucHVzaChmbik7XG59O1xuXG5Qcm9taXNlLnNwYXduID0gZnVuY3Rpb24gUHJvbWlzZSRTcGF3bihnZW5lcmF0b3JGdW5jdGlvbikge1xuICAgIGRlcHJlY2F0ZWQoXCJQcm9taXNlLnNwYXduIGlzIGRlcHJlY2F0ZWQuIFVzZSBQcm9taXNlLmNvcm91dGluZSBpbnN0ZWFkLlwiKTtcbiAgICBpZiAodHlwZW9mIGdlbmVyYXRvckZ1bmN0aW9uICE9PSBcImZ1bmN0aW9uXCIpIHtcbiAgICAgICAgcmV0dXJuIGFwaVJlamVjdGlvbihcImdlbmVyYXRvckZ1bmN0aW9uIG11c3QgYmUgYSBmdW5jdGlvblwiKTtcbiAgICB9XG4gICAgdmFyIHNwYXduID0gbmV3IFByb21pc2VTcGF3bihnZW5lcmF0b3JGdW5jdGlvbiwgdGhpcyk7XG4gICAgdmFyIHJldCA9IHNwYXduLnByb21pc2UoKTtcbiAgICBzcGF3bi5fcnVuKFByb21pc2Uuc3Bhd24pO1xuICAgIHJldHVybiByZXQ7XG59O1xufTtcbiIsIi8qKlxuICogVGhlIE1JVCBMaWNlbnNlIChNSVQpXG4gKiBcbiAqIENvcHlyaWdodCAoYykgMjAxNCBQZXRrYSBBbnRvbm92XG4gKiBcbiAqIFBlcm1pc3Npb24gaXMgaGVyZWJ5IGdyYW50ZWQsIGZyZWUgb2YgY2hhcmdlLCB0byBhbnkgcGVyc29uIG9idGFpbmluZyBhIGNvcHlcbiAqIG9mIHRoaXMgc29mdHdhcmUgYW5kIGFzc29jaWF0ZWQgZG9jdW1lbnRhdGlvbiBmaWxlcyAodGhlIFwiU29mdHdhcmVcIiksIHRvIGRlYWxcbiAqIGluIHRoZSBTb2Z0d2FyZSB3aXRob3V0IHJlc3RyaWN0aW9uLCBpbmNsdWRpbmcgd2l0aG91dCBsaW1pdGF0aW9uIHRoZSByaWdodHNcbiAqIHRvIHVzZSwgY29weSwgbW9kaWZ5LCBtZXJnZSwgcHVibGlzaCwgZGlzdHJpYnV0ZSwgc3VibGljZW5zZSwgYW5kL29yIHNlbGxcbiAqIGNvcGllcyBvZiB0aGUgU29mdHdhcmUsIGFuZCB0byBwZXJtaXQgcGVyc29ucyB0byB3aG9tIHRoZSBTb2Z0d2FyZSBpc1xuICogZnVybmlzaGVkIHRvIGRvIHNvLCBzdWJqZWN0IHRvIHRoZSBmb2xsb3dpbmcgY29uZGl0aW9uczo8L3A+XG4gKiBcbiAqIFRoZSBhYm92ZSBjb3B5cmlnaHQgbm90aWNlIGFuZCB0aGlzIHBlcm1pc3Npb24gbm90aWNlIHNoYWxsIGJlIGluY2x1ZGVkIGluXG4gKiBhbGwgY29waWVzIG9yIHN1YnN0YW50aWFsIHBvcnRpb25zIG9mIHRoZSBTb2Z0d2FyZS5cbiAqIFxuICogVEhFIFNPRlRXQVJFIElTIFBST1ZJREVEIFwiQVMgSVNcIiwgV0lUSE9VVCBXQVJSQU5UWSBPRiBBTlkgS0lORCwgRVhQUkVTUyBPUlxuICogSU1QTElFRCwgSU5DTFVESU5HIEJVVCBOT1QgTElNSVRFRCBUTyBUSEUgV0FSUkFOVElFUyBPRiBNRVJDSEFOVEFCSUxJVFksXG4gKiBGSVRORVNTIEZPUiBBIFBBUlRJQ1VMQVIgUFVSUE9TRSBBTkQgTk9OSU5GUklOR0VNRU5ULiAgSU4gTk8gRVZFTlQgU0hBTEwgVEhFXG4gKiBBVVRIT1JTIE9SIENPUFlSSUdIVCBIT0xERVJTIEJFIExJQUJMRSBGT1IgQU5ZIENMQUlNLCBEQU1BR0VTIE9SIE9USEVSXG4gKiBMSUFCSUxJVFksIFdIRVRIRVIgSU4gQU4gQUNUSU9OIE9GIENPTlRSQUNULCBUT1JUIE9SIE9USEVSV0lTRSwgQVJJU0lORyBGUk9NLFxuICogT1VUIE9GIE9SIElOIENPTk5FQ1RJT04gV0lUSCBUSEUgU09GVFdBUkUgT1IgVEhFIFVTRSBPUiBPVEhFUiBERUFMSU5HUyBJTlxuICogVEhFIFNPRlRXQVJFLlxuICogXG4gKi9cblwidXNlIHN0cmljdFwiO1xubW9kdWxlLmV4cG9ydHMgPVxuZnVuY3Rpb24oUHJvbWlzZSwgUHJvbWlzZUFycmF5LCBjYXN0LCBJTlRFUk5BTCkge1xudmFyIHV0aWwgPSByZXF1aXJlKFwiLi91dGlsLmpzXCIpO1xudmFyIGNhbkV2YWx1YXRlID0gdXRpbC5jYW5FdmFsdWF0ZTtcbnZhciB0cnlDYXRjaDEgPSB1dGlsLnRyeUNhdGNoMTtcbnZhciBlcnJvck9iaiA9IHV0aWwuZXJyb3JPYmo7XG5cblxuaWYgKGNhbkV2YWx1YXRlKSB7XG4gICAgdmFyIHRoZW5DYWxsYmFjayA9IGZ1bmN0aW9uKGkpIHtcbiAgICAgICAgcmV0dXJuIG5ldyBGdW5jdGlvbihcInZhbHVlXCIsIFwiaG9sZGVyXCIsIFwiICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcXG5cXFxuICAgICAgICAgICAgJ3VzZSBzdHJpY3QnOyAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcXG5cXFxuICAgICAgICAgICAgaG9sZGVyLnBJbmRleCA9IHZhbHVlOyAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcXG5cXFxuICAgICAgICAgICAgaG9sZGVyLmNoZWNrRnVsZmlsbG1lbnQodGhpcyk7ICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcXG5cXFxuICAgICAgICAgICAgXCIucmVwbGFjZSgvSW5kZXgvZywgaSkpO1xuICAgIH07XG5cbiAgICB2YXIgY2FsbGVyID0gZnVuY3Rpb24oY291bnQpIHtcbiAgICAgICAgdmFyIHZhbHVlcyA9IFtdO1xuICAgICAgICBmb3IgKHZhciBpID0gMTsgaSA8PSBjb3VudDsgKytpKSB2YWx1ZXMucHVzaChcImhvbGRlci5wXCIgKyBpKTtcbiAgICAgICAgcmV0dXJuIG5ldyBGdW5jdGlvbihcImhvbGRlclwiLCBcIiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXFxuXFxcbiAgICAgICAgICAgICd1c2Ugc3RyaWN0JzsgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXFxuXFxcbiAgICAgICAgICAgIHZhciBjYWxsYmFjayA9IGhvbGRlci5mbjsgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXFxuXFxcbiAgICAgICAgICAgIHJldHVybiBjYWxsYmFjayh2YWx1ZXMpOyAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXFxuXFxcbiAgICAgICAgICAgIFwiLnJlcGxhY2UoL3ZhbHVlcy9nLCB2YWx1ZXMuam9pbihcIiwgXCIpKSk7XG4gICAgfTtcbiAgICB2YXIgdGhlbkNhbGxiYWNrcyA9IFtdO1xuICAgIHZhciBjYWxsZXJzID0gW3ZvaWQgMF07XG4gICAgZm9yICh2YXIgaSA9IDE7IGkgPD0gNTsgKytpKSB7XG4gICAgICAgIHRoZW5DYWxsYmFja3MucHVzaCh0aGVuQ2FsbGJhY2soaSkpO1xuICAgICAgICBjYWxsZXJzLnB1c2goY2FsbGVyKGkpKTtcbiAgICB9XG5cbiAgICB2YXIgSG9sZGVyID0gZnVuY3Rpb24odG90YWwsIGZuKSB7XG4gICAgICAgIHRoaXMucDEgPSB0aGlzLnAyID0gdGhpcy5wMyA9IHRoaXMucDQgPSB0aGlzLnA1ID0gbnVsbDtcbiAgICAgICAgdGhpcy5mbiA9IGZuO1xuICAgICAgICB0aGlzLnRvdGFsID0gdG90YWw7XG4gICAgICAgIHRoaXMubm93ID0gMDtcbiAgICB9O1xuXG4gICAgSG9sZGVyLnByb3RvdHlwZS5jYWxsZXJzID0gY2FsbGVycztcbiAgICBIb2xkZXIucHJvdG90eXBlLmNoZWNrRnVsZmlsbG1lbnQgPSBmdW5jdGlvbihwcm9taXNlKSB7XG4gICAgICAgIHZhciBub3cgPSB0aGlzLm5vdztcbiAgICAgICAgbm93Kys7XG4gICAgICAgIHZhciB0b3RhbCA9IHRoaXMudG90YWw7XG4gICAgICAgIGlmIChub3cgPj0gdG90YWwpIHtcbiAgICAgICAgICAgIHZhciBoYW5kbGVyID0gdGhpcy5jYWxsZXJzW3RvdGFsXTtcbiAgICAgICAgICAgIHZhciByZXQgPSB0cnlDYXRjaDEoaGFuZGxlciwgdm9pZCAwLCB0aGlzKTtcbiAgICAgICAgICAgIGlmIChyZXQgPT09IGVycm9yT2JqKSB7XG4gICAgICAgICAgICAgICAgcHJvbWlzZS5fcmVqZWN0VW5jaGVja2VkKHJldC5lKTtcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoIXByb21pc2UuX3RyeUZvbGxvdyhyZXQpKSB7XG4gICAgICAgICAgICAgICAgcHJvbWlzZS5fZnVsZmlsbFVuY2hlY2tlZChyZXQpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgdGhpcy5ub3cgPSBub3c7XG4gICAgICAgIH1cbiAgICB9O1xufVxuXG5mdW5jdGlvbiByZWplY3QocmVhc29uKSB7XG4gICAgdGhpcy5fcmVqZWN0KHJlYXNvbik7XG59XG5cblByb21pc2Uuam9pbiA9IGZ1bmN0aW9uIFByb21pc2UkSm9pbigpIHtcbiAgICB2YXIgbGFzdCA9IGFyZ3VtZW50cy5sZW5ndGggLSAxO1xuICAgIHZhciBmbjtcbiAgICBpZiAobGFzdCA+IDAgJiYgdHlwZW9mIGFyZ3VtZW50c1tsYXN0XSA9PT0gXCJmdW5jdGlvblwiKSB7XG4gICAgICAgIGZuID0gYXJndW1lbnRzW2xhc3RdO1xuICAgICAgICBpZiAobGFzdCA8IDYgJiYgY2FuRXZhbHVhdGUpIHtcbiAgICAgICAgICAgIHZhciByZXQgPSBuZXcgUHJvbWlzZShJTlRFUk5BTCk7XG4gICAgICAgICAgICByZXQuX3NldFRyYWNlKHZvaWQgMCk7XG4gICAgICAgICAgICB2YXIgaG9sZGVyID0gbmV3IEhvbGRlcihsYXN0LCBmbik7XG4gICAgICAgICAgICB2YXIgY2FsbGJhY2tzID0gdGhlbkNhbGxiYWNrcztcbiAgICAgICAgICAgIGZvciAodmFyIGkgPSAwOyBpIDwgbGFzdDsgKytpKSB7XG4gICAgICAgICAgICAgICAgdmFyIG1heWJlUHJvbWlzZSA9IGNhc3QoYXJndW1lbnRzW2ldLCB2b2lkIDApO1xuICAgICAgICAgICAgICAgIGlmIChtYXliZVByb21pc2UgaW5zdGFuY2VvZiBQcm9taXNlKSB7XG4gICAgICAgICAgICAgICAgICAgIGlmIChtYXliZVByb21pc2UuaXNQZW5kaW5nKCkpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIG1heWJlUHJvbWlzZS5fdGhlbihjYWxsYmFja3NbaV0sIHJlamVjdCxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB2b2lkIDAsIHJldCwgaG9sZGVyKTtcbiAgICAgICAgICAgICAgICAgICAgfSBlbHNlIGlmIChtYXliZVByb21pc2UuaXNGdWxmaWxsZWQoKSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgY2FsbGJhY2tzW2ldLmNhbGwocmV0LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgbWF5YmVQcm9taXNlLl9zZXR0bGVkVmFsdWUsIGhvbGRlcik7XG4gICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgICAgICByZXQuX3JlamVjdChtYXliZVByb21pc2UuX3NldHRsZWRWYWx1ZSk7XG4gICAgICAgICAgICAgICAgICAgICAgICBtYXliZVByb21pc2UuX3Vuc2V0UmVqZWN0aW9uSXNVbmhhbmRsZWQoKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIGNhbGxiYWNrc1tpXS5jYWxsKHJldCwgbWF5YmVQcm9taXNlLCBob2xkZXIpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHJldHVybiByZXQ7XG4gICAgICAgIH1cbiAgICB9XG4gICAgdmFyICRfbGVuID0gYXJndW1lbnRzLmxlbmd0aDt2YXIgYXJncyA9IG5ldyBBcnJheSgkX2xlbik7IGZvcih2YXIgJF9pID0gMDsgJF9pIDwgJF9sZW47ICsrJF9pKSB7YXJnc1skX2ldID0gYXJndW1lbnRzWyRfaV07fVxuICAgIHZhciByZXQgPSBuZXcgUHJvbWlzZUFycmF5KGFyZ3MpLnByb21pc2UoKTtcbiAgICByZXR1cm4gZm4gIT09IHZvaWQgMCA/IHJldC5zcHJlYWQoZm4pIDogcmV0O1xufTtcblxufTtcbiIsIi8qKlxuICogVGhlIE1JVCBMaWNlbnNlIChNSVQpXG4gKiBcbiAqIENvcHlyaWdodCAoYykgMjAxNCBQZXRrYSBBbnRvbm92XG4gKiBcbiAqIFBlcm1pc3Npb24gaXMgaGVyZWJ5IGdyYW50ZWQsIGZyZWUgb2YgY2hhcmdlLCB0byBhbnkgcGVyc29uIG9idGFpbmluZyBhIGNvcHlcbiAqIG9mIHRoaXMgc29mdHdhcmUgYW5kIGFzc29jaWF0ZWQgZG9jdW1lbnRhdGlvbiBmaWxlcyAodGhlIFwiU29mdHdhcmVcIiksIHRvIGRlYWxcbiAqIGluIHRoZSBTb2Z0d2FyZSB3aXRob3V0IHJlc3RyaWN0aW9uLCBpbmNsdWRpbmcgd2l0aG91dCBsaW1pdGF0aW9uIHRoZSByaWdodHNcbiAqIHRvIHVzZSwgY29weSwgbW9kaWZ5LCBtZXJnZSwgcHVibGlzaCwgZGlzdHJpYnV0ZSwgc3VibGljZW5zZSwgYW5kL29yIHNlbGxcbiAqIGNvcGllcyBvZiB0aGUgU29mdHdhcmUsIGFuZCB0byBwZXJtaXQgcGVyc29ucyB0byB3aG9tIHRoZSBTb2Z0d2FyZSBpc1xuICogZnVybmlzaGVkIHRvIGRvIHNvLCBzdWJqZWN0IHRvIHRoZSBmb2xsb3dpbmcgY29uZGl0aW9uczo8L3A+XG4gKiBcbiAqIFRoZSBhYm92ZSBjb3B5cmlnaHQgbm90aWNlIGFuZCB0aGlzIHBlcm1pc3Npb24gbm90aWNlIHNoYWxsIGJlIGluY2x1ZGVkIGluXG4gKiBhbGwgY29waWVzIG9yIHN1YnN0YW50aWFsIHBvcnRpb25zIG9mIHRoZSBTb2Z0d2FyZS5cbiAqIFxuICogVEhFIFNPRlRXQVJFIElTIFBST1ZJREVEIFwiQVMgSVNcIiwgV0lUSE9VVCBXQVJSQU5UWSBPRiBBTlkgS0lORCwgRVhQUkVTUyBPUlxuICogSU1QTElFRCwgSU5DTFVESU5HIEJVVCBOT1QgTElNSVRFRCBUTyBUSEUgV0FSUkFOVElFUyBPRiBNRVJDSEFOVEFCSUxJVFksXG4gKiBGSVRORVNTIEZPUiBBIFBBUlRJQ1VMQVIgUFVSUE9TRSBBTkQgTk9OSU5GUklOR0VNRU5ULiAgSU4gTk8gRVZFTlQgU0hBTEwgVEhFXG4gKiBBVVRIT1JTIE9SIENPUFlSSUdIVCBIT0xERVJTIEJFIExJQUJMRSBGT1IgQU5ZIENMQUlNLCBEQU1BR0VTIE9SIE9USEVSXG4gKiBMSUFCSUxJVFksIFdIRVRIRVIgSU4gQU4gQUNUSU9OIE9GIENPTlRSQUNULCBUT1JUIE9SIE9USEVSV0lTRSwgQVJJU0lORyBGUk9NLFxuICogT1VUIE9GIE9SIElOIENPTk5FQ1RJT04gV0lUSCBUSEUgU09GVFdBUkUgT1IgVEhFIFVTRSBPUiBPVEhFUiBERUFMSU5HUyBJTlxuICogVEhFIFNPRlRXQVJFLlxuICogXG4gKi9cblwidXNlIHN0cmljdFwiO1xubW9kdWxlLmV4cG9ydHMgPSBmdW5jdGlvbihQcm9taXNlLCBQcm9taXNlQXJyYXksIGFwaVJlamVjdGlvbiwgY2FzdCwgSU5URVJOQUwpIHtcbnZhciB1dGlsID0gcmVxdWlyZShcIi4vdXRpbC5qc1wiKTtcbnZhciB0cnlDYXRjaDMgPSB1dGlsLnRyeUNhdGNoMztcbnZhciBlcnJvck9iaiA9IHV0aWwuZXJyb3JPYmo7XG52YXIgUEVORElORyA9IHt9O1xudmFyIEVNUFRZX0FSUkFZID0gW107XG5cbmZ1bmN0aW9uIE1hcHBpbmdQcm9taXNlQXJyYXkocHJvbWlzZXMsIGZuLCBsaW1pdCwgX2ZpbHRlcikge1xuICAgIHRoaXMuY29uc3RydWN0b3IkKHByb21pc2VzKTtcbiAgICB0aGlzLl9jYWxsYmFjayA9IGZuO1xuICAgIHRoaXMuX3ByZXNlcnZlZFZhbHVlcyA9IF9maWx0ZXIgPT09IElOVEVSTkFMXG4gICAgICAgID8gbmV3IEFycmF5KHRoaXMubGVuZ3RoKCkpXG4gICAgICAgIDogbnVsbDtcbiAgICB0aGlzLl9saW1pdCA9IGxpbWl0O1xuICAgIHRoaXMuX2luRmxpZ2h0ID0gMDtcbiAgICB0aGlzLl9xdWV1ZSA9IGxpbWl0ID49IDEgPyBbXSA6IEVNUFRZX0FSUkFZO1xuICAgIHRoaXMuX2luaXQkKHZvaWQgMCwgLTIpO1xufVxudXRpbC5pbmhlcml0cyhNYXBwaW5nUHJvbWlzZUFycmF5LCBQcm9taXNlQXJyYXkpO1xuXG5NYXBwaW5nUHJvbWlzZUFycmF5LnByb3RvdHlwZS5faW5pdCA9IGZ1bmN0aW9uIE1hcHBpbmdQcm9taXNlQXJyYXkkX2luaXQoKSB7fTtcblxuTWFwcGluZ1Byb21pc2VBcnJheS5wcm90b3R5cGUuX3Byb21pc2VGdWxmaWxsZWQgPVxuZnVuY3Rpb24gTWFwcGluZ1Byb21pc2VBcnJheSRfcHJvbWlzZUZ1bGZpbGxlZCh2YWx1ZSwgaW5kZXgpIHtcbiAgICB2YXIgdmFsdWVzID0gdGhpcy5fdmFsdWVzO1xuICAgIGlmICh2YWx1ZXMgPT09IG51bGwpIHJldHVybjtcblxuICAgIHZhciBsZW5ndGggPSB0aGlzLmxlbmd0aCgpO1xuICAgIHZhciBwcmVzZXJ2ZWRWYWx1ZXMgPSB0aGlzLl9wcmVzZXJ2ZWRWYWx1ZXM7XG4gICAgdmFyIGxpbWl0ID0gdGhpcy5fbGltaXQ7XG4gICAgaWYgKHZhbHVlc1tpbmRleF0gPT09IFBFTkRJTkcpIHtcbiAgICAgICAgdmFsdWVzW2luZGV4XSA9IHZhbHVlO1xuICAgICAgICBpZiAobGltaXQgPj0gMSkge1xuICAgICAgICAgICAgdGhpcy5faW5GbGlnaHQtLTtcbiAgICAgICAgICAgIHRoaXMuX2RyYWluUXVldWUoKTtcbiAgICAgICAgICAgIGlmICh0aGlzLl9pc1Jlc29sdmVkKCkpIHJldHVybjtcbiAgICAgICAgfVxuICAgIH0gZWxzZSB7XG4gICAgICAgIGlmIChsaW1pdCA+PSAxICYmIHRoaXMuX2luRmxpZ2h0ID49IGxpbWl0KSB7XG4gICAgICAgICAgICB2YWx1ZXNbaW5kZXhdID0gdmFsdWU7XG4gICAgICAgICAgICB0aGlzLl9xdWV1ZS5wdXNoKGluZGV4KTtcbiAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuICAgICAgICBpZiAocHJlc2VydmVkVmFsdWVzICE9PSBudWxsKSBwcmVzZXJ2ZWRWYWx1ZXNbaW5kZXhdID0gdmFsdWU7XG5cbiAgICAgICAgdmFyIGNhbGxiYWNrID0gdGhpcy5fY2FsbGJhY2s7XG4gICAgICAgIHZhciByZWNlaXZlciA9IHRoaXMuX3Byb21pc2UuX2JvdW5kVG87XG4gICAgICAgIHZhciByZXQgPSB0cnlDYXRjaDMoY2FsbGJhY2ssIHJlY2VpdmVyLCB2YWx1ZSwgaW5kZXgsIGxlbmd0aCk7XG4gICAgICAgIGlmIChyZXQgPT09IGVycm9yT2JqKSByZXR1cm4gdGhpcy5fcmVqZWN0KHJldC5lKTtcblxuICAgICAgICB2YXIgbWF5YmVQcm9taXNlID0gY2FzdChyZXQsIHZvaWQgMCk7XG4gICAgICAgIGlmIChtYXliZVByb21pc2UgaW5zdGFuY2VvZiBQcm9taXNlKSB7XG4gICAgICAgICAgICBpZiAobWF5YmVQcm9taXNlLmlzUGVuZGluZygpKSB7XG4gICAgICAgICAgICAgICAgaWYgKGxpbWl0ID49IDEpIHRoaXMuX2luRmxpZ2h0Kys7XG4gICAgICAgICAgICAgICAgdmFsdWVzW2luZGV4XSA9IFBFTkRJTkc7XG4gICAgICAgICAgICAgICAgcmV0dXJuIG1heWJlUHJvbWlzZS5fcHJveHlQcm9taXNlQXJyYXkodGhpcywgaW5kZXgpO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChtYXliZVByb21pc2UuaXNGdWxmaWxsZWQoKSkge1xuICAgICAgICAgICAgICAgIHJldCA9IG1heWJlUHJvbWlzZS52YWx1ZSgpO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBtYXliZVByb21pc2UuX3Vuc2V0UmVqZWN0aW9uSXNVbmhhbmRsZWQoKTtcbiAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fcmVqZWN0KG1heWJlUHJvbWlzZS5yZWFzb24oKSk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgICAgdmFsdWVzW2luZGV4XSA9IHJldDtcbiAgICB9XG4gICAgdmFyIHRvdGFsUmVzb2x2ZWQgPSArK3RoaXMuX3RvdGFsUmVzb2x2ZWQ7XG4gICAgaWYgKHRvdGFsUmVzb2x2ZWQgPj0gbGVuZ3RoKSB7XG4gICAgICAgIGlmIChwcmVzZXJ2ZWRWYWx1ZXMgIT09IG51bGwpIHtcbiAgICAgICAgICAgIHRoaXMuX2ZpbHRlcih2YWx1ZXMsIHByZXNlcnZlZFZhbHVlcyk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICB0aGlzLl9yZXNvbHZlKHZhbHVlcyk7XG4gICAgICAgIH1cblxuICAgIH1cbn07XG5cbk1hcHBpbmdQcm9taXNlQXJyYXkucHJvdG90eXBlLl9kcmFpblF1ZXVlID1cbmZ1bmN0aW9uIE1hcHBpbmdQcm9taXNlQXJyYXkkX2RyYWluUXVldWUoKSB7XG4gICAgdmFyIHF1ZXVlID0gdGhpcy5fcXVldWU7XG4gICAgdmFyIGxpbWl0ID0gdGhpcy5fbGltaXQ7XG4gICAgdmFyIHZhbHVlcyA9IHRoaXMuX3ZhbHVlcztcbiAgICB3aGlsZSAocXVldWUubGVuZ3RoID4gMCAmJiB0aGlzLl9pbkZsaWdodCA8IGxpbWl0KSB7XG4gICAgICAgIHZhciBpbmRleCA9IHF1ZXVlLnBvcCgpO1xuICAgICAgICB0aGlzLl9wcm9taXNlRnVsZmlsbGVkKHZhbHVlc1tpbmRleF0sIGluZGV4KTtcbiAgICB9XG59O1xuXG5NYXBwaW5nUHJvbWlzZUFycmF5LnByb3RvdHlwZS5fZmlsdGVyID1cbmZ1bmN0aW9uIE1hcHBpbmdQcm9taXNlQXJyYXkkX2ZpbHRlcihib29sZWFucywgdmFsdWVzKSB7XG4gICAgdmFyIGxlbiA9IHZhbHVlcy5sZW5ndGg7XG4gICAgdmFyIHJldCA9IG5ldyBBcnJheShsZW4pO1xuICAgIHZhciBqID0gMDtcbiAgICBmb3IgKHZhciBpID0gMDsgaSA8IGxlbjsgKytpKSB7XG4gICAgICAgIGlmIChib29sZWFuc1tpXSkgcmV0W2orK10gPSB2YWx1ZXNbaV07XG4gICAgfVxuICAgIHJldC5sZW5ndGggPSBqO1xuICAgIHRoaXMuX3Jlc29sdmUocmV0KTtcbn07XG5cbk1hcHBpbmdQcm9taXNlQXJyYXkucHJvdG90eXBlLnByZXNlcnZlZFZhbHVlcyA9XG5mdW5jdGlvbiBNYXBwaW5nUHJvbWlzZUFycmF5JHByZXNlcnZlVmFsdWVzKCkge1xuICAgIHJldHVybiB0aGlzLl9wcmVzZXJ2ZWRWYWx1ZXM7XG59O1xuXG5mdW5jdGlvbiBtYXAocHJvbWlzZXMsIGZuLCBvcHRpb25zLCBfZmlsdGVyKSB7XG4gICAgdmFyIGxpbWl0ID0gdHlwZW9mIG9wdGlvbnMgPT09IFwib2JqZWN0XCIgJiYgb3B0aW9ucyAhPT0gbnVsbFxuICAgICAgICA/IG9wdGlvbnMuY29uY3VycmVuY3lcbiAgICAgICAgOiAwO1xuICAgIGxpbWl0ID0gdHlwZW9mIGxpbWl0ID09PSBcIm51bWJlclwiICYmXG4gICAgICAgIGlzRmluaXRlKGxpbWl0KSAmJiBsaW1pdCA+PSAxID8gbGltaXQgOiAwO1xuICAgIHJldHVybiBuZXcgTWFwcGluZ1Byb21pc2VBcnJheShwcm9taXNlcywgZm4sIGxpbWl0LCBfZmlsdGVyKTtcbn1cblxuUHJvbWlzZS5wcm90b3R5cGUubWFwID0gZnVuY3Rpb24gUHJvbWlzZSRtYXAoZm4sIG9wdGlvbnMpIHtcbiAgICBpZiAodHlwZW9mIGZuICE9PSBcImZ1bmN0aW9uXCIpIHJldHVybiBhcGlSZWplY3Rpb24oXCJmbiBtdXN0IGJlIGEgZnVuY3Rpb25cIik7XG5cbiAgICByZXR1cm4gbWFwKHRoaXMsIGZuLCBvcHRpb25zLCBudWxsKS5wcm9taXNlKCk7XG59O1xuXG5Qcm9taXNlLm1hcCA9IGZ1bmN0aW9uIFByb21pc2UkTWFwKHByb21pc2VzLCBmbiwgb3B0aW9ucywgX2ZpbHRlcikge1xuICAgIGlmICh0eXBlb2YgZm4gIT09IFwiZnVuY3Rpb25cIikgcmV0dXJuIGFwaVJlamVjdGlvbihcImZuIG11c3QgYmUgYSBmdW5jdGlvblwiKTtcbiAgICByZXR1cm4gbWFwKHByb21pc2VzLCBmbiwgb3B0aW9ucywgX2ZpbHRlcikucHJvbWlzZSgpO1xufTtcblxuXG59O1xuIiwiLyoqXG4gKiBUaGUgTUlUIExpY2Vuc2UgKE1JVClcbiAqIFxuICogQ29weXJpZ2h0IChjKSAyMDE0IFBldGthIEFudG9ub3ZcbiAqIFxuICogUGVybWlzc2lvbiBpcyBoZXJlYnkgZ3JhbnRlZCwgZnJlZSBvZiBjaGFyZ2UsIHRvIGFueSBwZXJzb24gb2J0YWluaW5nIGEgY29weVxuICogb2YgdGhpcyBzb2Z0d2FyZSBhbmQgYXNzb2NpYXRlZCBkb2N1bWVudGF0aW9uIGZpbGVzICh0aGUgXCJTb2Z0d2FyZVwiKSwgdG8gZGVhbFxuICogaW4gdGhlIFNvZnR3YXJlIHdpdGhvdXQgcmVzdHJpY3Rpb24sIGluY2x1ZGluZyB3aXRob3V0IGxpbWl0YXRpb24gdGhlIHJpZ2h0c1xuICogdG8gdXNlLCBjb3B5LCBtb2RpZnksIG1lcmdlLCBwdWJsaXNoLCBkaXN0cmlidXRlLCBzdWJsaWNlbnNlLCBhbmQvb3Igc2VsbFxuICogY29waWVzIG9mIHRoZSBTb2Z0d2FyZSwgYW5kIHRvIHBlcm1pdCBwZXJzb25zIHRvIHdob20gdGhlIFNvZnR3YXJlIGlzXG4gKiBmdXJuaXNoZWQgdG8gZG8gc28sIHN1YmplY3QgdG8gdGhlIGZvbGxvd2luZyBjb25kaXRpb25zOjwvcD5cbiAqIFxuICogVGhlIGFib3ZlIGNvcHlyaWdodCBub3RpY2UgYW5kIHRoaXMgcGVybWlzc2lvbiBub3RpY2Ugc2hhbGwgYmUgaW5jbHVkZWQgaW5cbiAqIGFsbCBjb3BpZXMgb3Igc3Vic3RhbnRpYWwgcG9ydGlvbnMgb2YgdGhlIFNvZnR3YXJlLlxuICogXG4gKiBUSEUgU09GVFdBUkUgSVMgUFJPVklERUQgXCJBUyBJU1wiLCBXSVRIT1VUIFdBUlJBTlRZIE9GIEFOWSBLSU5ELCBFWFBSRVNTIE9SXG4gKiBJTVBMSUVELCBJTkNMVURJTkcgQlVUIE5PVCBMSU1JVEVEIFRPIFRIRSBXQVJSQU5USUVTIE9GIE1FUkNIQU5UQUJJTElUWSxcbiAqIEZJVE5FU1MgRk9SIEEgUEFSVElDVUxBUiBQVVJQT1NFIEFORCBOT05JTkZSSU5HRU1FTlQuICBJTiBOTyBFVkVOVCBTSEFMTCBUSEVcbiAqIEFVVEhPUlMgT1IgQ09QWVJJR0hUIEhPTERFUlMgQkUgTElBQkxFIEZPUiBBTlkgQ0xBSU0sIERBTUFHRVMgT1IgT1RIRVJcbiAqIExJQUJJTElUWSwgV0hFVEhFUiBJTiBBTiBBQ1RJT04gT0YgQ09OVFJBQ1QsIFRPUlQgT1IgT1RIRVJXSVNFLCBBUklTSU5HIEZST00sXG4gKiBPVVQgT0YgT1IgSU4gQ09OTkVDVElPTiBXSVRIIFRIRSBTT0ZUV0FSRSBPUiBUSEUgVVNFIE9SIE9USEVSIERFQUxJTkdTIElOXG4gKiBUSEUgU09GVFdBUkUuXG4gKiBcbiAqL1xuXCJ1c2Ugc3RyaWN0XCI7XG5tb2R1bGUuZXhwb3J0cyA9IGZ1bmN0aW9uKFByb21pc2UpIHtcbnZhciB1dGlsID0gcmVxdWlyZShcIi4vdXRpbC5qc1wiKTtcbnZhciBhc3luYyA9IHJlcXVpcmUoXCIuL2FzeW5jLmpzXCIpO1xudmFyIHRyeUNhdGNoMiA9IHV0aWwudHJ5Q2F0Y2gyO1xudmFyIHRyeUNhdGNoMSA9IHV0aWwudHJ5Q2F0Y2gxO1xudmFyIGVycm9yT2JqID0gdXRpbC5lcnJvck9iajtcblxuZnVuY3Rpb24gdGhyb3dlcihyKSB7XG4gICAgdGhyb3cgcjtcbn1cblxuZnVuY3Rpb24gUHJvbWlzZSRfc3ByZWFkQWRhcHRlcih2YWwsIHJlY2VpdmVyKSB7XG4gICAgaWYgKCF1dGlsLmlzQXJyYXkodmFsKSkgcmV0dXJuIFByb21pc2UkX3N1Y2Nlc3NBZGFwdGVyKHZhbCwgcmVjZWl2ZXIpO1xuICAgIHZhciByZXQgPSB1dGlsLnRyeUNhdGNoQXBwbHkodGhpcywgW251bGxdLmNvbmNhdCh2YWwpLCByZWNlaXZlcik7XG4gICAgaWYgKHJldCA9PT0gZXJyb3JPYmopIHtcbiAgICAgICAgYXN5bmMuaW52b2tlTGF0ZXIodGhyb3dlciwgdm9pZCAwLCByZXQuZSk7XG4gICAgfVxufVxuXG5mdW5jdGlvbiBQcm9taXNlJF9zdWNjZXNzQWRhcHRlcih2YWwsIHJlY2VpdmVyKSB7XG4gICAgdmFyIG5vZGViYWNrID0gdGhpcztcbiAgICB2YXIgcmV0ID0gdmFsID09PSB2b2lkIDBcbiAgICAgICAgPyB0cnlDYXRjaDEobm9kZWJhY2ssIHJlY2VpdmVyLCBudWxsKVxuICAgICAgICA6IHRyeUNhdGNoMihub2RlYmFjaywgcmVjZWl2ZXIsIG51bGwsIHZhbCk7XG4gICAgaWYgKHJldCA9PT0gZXJyb3JPYmopIHtcbiAgICAgICAgYXN5bmMuaW52b2tlTGF0ZXIodGhyb3dlciwgdm9pZCAwLCByZXQuZSk7XG4gICAgfVxufVxuZnVuY3Rpb24gUHJvbWlzZSRfZXJyb3JBZGFwdGVyKHJlYXNvbiwgcmVjZWl2ZXIpIHtcbiAgICB2YXIgbm9kZWJhY2sgPSB0aGlzO1xuICAgIHZhciByZXQgPSB0cnlDYXRjaDEobm9kZWJhY2ssIHJlY2VpdmVyLCByZWFzb24pO1xuICAgIGlmIChyZXQgPT09IGVycm9yT2JqKSB7XG4gICAgICAgIGFzeW5jLmludm9rZUxhdGVyKHRocm93ZXIsIHZvaWQgMCwgcmV0LmUpO1xuICAgIH1cbn1cblxuUHJvbWlzZS5wcm90b3R5cGUubm9kZWlmeSA9IGZ1bmN0aW9uIFByb21pc2Ukbm9kZWlmeShub2RlYmFjaywgb3B0aW9ucykge1xuICAgIGlmICh0eXBlb2Ygbm9kZWJhY2sgPT0gXCJmdW5jdGlvblwiKSB7XG4gICAgICAgIHZhciBhZGFwdGVyID0gUHJvbWlzZSRfc3VjY2Vzc0FkYXB0ZXI7XG4gICAgICAgIGlmIChvcHRpb25zICE9PSB2b2lkIDAgJiYgT2JqZWN0KG9wdGlvbnMpLnNwcmVhZCkge1xuICAgICAgICAgICAgYWRhcHRlciA9IFByb21pc2UkX3NwcmVhZEFkYXB0ZXI7XG4gICAgICAgIH1cbiAgICAgICAgdGhpcy5fdGhlbihcbiAgICAgICAgICAgIGFkYXB0ZXIsXG4gICAgICAgICAgICBQcm9taXNlJF9lcnJvckFkYXB0ZXIsXG4gICAgICAgICAgICB2b2lkIDAsXG4gICAgICAgICAgICBub2RlYmFjayxcbiAgICAgICAgICAgIHRoaXMuX2JvdW5kVG9cbiAgICAgICAgKTtcbiAgICB9XG4gICAgcmV0dXJuIHRoaXM7XG59O1xufTtcbiIsIi8qKlxuICogVGhlIE1JVCBMaWNlbnNlIChNSVQpXG4gKiBcbiAqIENvcHlyaWdodCAoYykgMjAxNCBQZXRrYSBBbnRvbm92XG4gKiBcbiAqIFBlcm1pc3Npb24gaXMgaGVyZWJ5IGdyYW50ZWQsIGZyZWUgb2YgY2hhcmdlLCB0byBhbnkgcGVyc29uIG9idGFpbmluZyBhIGNvcHlcbiAqIG9mIHRoaXMgc29mdHdhcmUgYW5kIGFzc29jaWF0ZWQgZG9jdW1lbnRhdGlvbiBmaWxlcyAodGhlIFwiU29mdHdhcmVcIiksIHRvIGRlYWxcbiAqIGluIHRoZSBTb2Z0d2FyZSB3aXRob3V0IHJlc3RyaWN0aW9uLCBpbmNsdWRpbmcgd2l0aG91dCBsaW1pdGF0aW9uIHRoZSByaWdodHNcbiAqIHRvIHVzZSwgY29weSwgbW9kaWZ5LCBtZXJnZSwgcHVibGlzaCwgZGlzdHJpYnV0ZSwgc3VibGljZW5zZSwgYW5kL29yIHNlbGxcbiAqIGNvcGllcyBvZiB0aGUgU29mdHdhcmUsIGFuZCB0byBwZXJtaXQgcGVyc29ucyB0byB3aG9tIHRoZSBTb2Z0d2FyZSBpc1xuICogZnVybmlzaGVkIHRvIGRvIHNvLCBzdWJqZWN0IHRvIHRoZSBmb2xsb3dpbmcgY29uZGl0aW9uczo8L3A+XG4gKiBcbiAqIFRoZSBhYm92ZSBjb3B5cmlnaHQgbm90aWNlIGFuZCB0aGlzIHBlcm1pc3Npb24gbm90aWNlIHNoYWxsIGJlIGluY2x1ZGVkIGluXG4gKiBhbGwgY29waWVzIG9yIHN1YnN0YW50aWFsIHBvcnRpb25zIG9mIHRoZSBTb2Z0d2FyZS5cbiAqIFxuICogVEhFIFNPRlRXQVJFIElTIFBST1ZJREVEIFwiQVMgSVNcIiwgV0lUSE9VVCBXQVJSQU5UWSBPRiBBTlkgS0lORCwgRVhQUkVTUyBPUlxuICogSU1QTElFRCwgSU5DTFVESU5HIEJVVCBOT1QgTElNSVRFRCBUTyBUSEUgV0FSUkFOVElFUyBPRiBNRVJDSEFOVEFCSUxJVFksXG4gKiBGSVRORVNTIEZPUiBBIFBBUlRJQ1VMQVIgUFVSUE9TRSBBTkQgTk9OSU5GUklOR0VNRU5ULiAgSU4gTk8gRVZFTlQgU0hBTEwgVEhFXG4gKiBBVVRIT1JTIE9SIENPUFlSSUdIVCBIT0xERVJTIEJFIExJQUJMRSBGT1IgQU5ZIENMQUlNLCBEQU1BR0VTIE9SIE9USEVSXG4gKiBMSUFCSUxJVFksIFdIRVRIRVIgSU4gQU4gQUNUSU9OIE9GIENPTlRSQUNULCBUT1JUIE9SIE9USEVSV0lTRSwgQVJJU0lORyBGUk9NLFxuICogT1VUIE9GIE9SIElOIENPTk5FQ1RJT04gV0lUSCBUSEUgU09GVFdBUkUgT1IgVEhFIFVTRSBPUiBPVEhFUiBERUFMSU5HUyBJTlxuICogVEhFIFNPRlRXQVJFLlxuICogXG4gKi9cblwidXNlIHN0cmljdFwiO1xubW9kdWxlLmV4cG9ydHMgPSBmdW5jdGlvbihQcm9taXNlLCBQcm9taXNlQXJyYXkpIHtcbnZhciB1dGlsID0gcmVxdWlyZShcIi4vdXRpbC5qc1wiKTtcbnZhciBhc3luYyA9IHJlcXVpcmUoXCIuL2FzeW5jLmpzXCIpO1xudmFyIGVycm9ycyA9IHJlcXVpcmUoXCIuL2Vycm9ycy5qc1wiKTtcbnZhciB0cnlDYXRjaDEgPSB1dGlsLnRyeUNhdGNoMTtcbnZhciBlcnJvck9iaiA9IHV0aWwuZXJyb3JPYmo7XG5cblByb21pc2UucHJvdG90eXBlLnByb2dyZXNzZWQgPSBmdW5jdGlvbiBQcm9taXNlJHByb2dyZXNzZWQoaGFuZGxlcikge1xuICAgIHJldHVybiB0aGlzLl90aGVuKHZvaWQgMCwgdm9pZCAwLCBoYW5kbGVyLCB2b2lkIDAsIHZvaWQgMCk7XG59O1xuXG5Qcm9taXNlLnByb3RvdHlwZS5fcHJvZ3Jlc3MgPSBmdW5jdGlvbiBQcm9taXNlJF9wcm9ncmVzcyhwcm9ncmVzc1ZhbHVlKSB7XG4gICAgaWYgKHRoaXMuX2lzRm9sbG93aW5nT3JGdWxmaWxsZWRPclJlamVjdGVkKCkpIHJldHVybjtcbiAgICB0aGlzLl9wcm9ncmVzc1VuY2hlY2tlZChwcm9ncmVzc1ZhbHVlKTtcblxufTtcblxuUHJvbWlzZS5wcm90b3R5cGUuX2NsZWFyRmlyc3RIYW5kbGVyRGF0YSRCYXNlID1cblByb21pc2UucHJvdG90eXBlLl9jbGVhckZpcnN0SGFuZGxlckRhdGE7XG5Qcm9taXNlLnByb3RvdHlwZS5fY2xlYXJGaXJzdEhhbmRsZXJEYXRhID1cbmZ1bmN0aW9uIFByb21pc2UkX2NsZWFyRmlyc3RIYW5kbGVyRGF0YSgpIHtcbiAgICB0aGlzLl9jbGVhckZpcnN0SGFuZGxlckRhdGEkQmFzZSgpO1xuICAgIHRoaXMuX3Byb2dyZXNzSGFuZGxlcjAgPSB2b2lkIDA7XG59O1xuXG5Qcm9taXNlLnByb3RvdHlwZS5fcHJvZ3Jlc3NIYW5kbGVyQXQgPVxuZnVuY3Rpb24gUHJvbWlzZSRfcHJvZ3Jlc3NIYW5kbGVyQXQoaW5kZXgpIHtcbiAgICByZXR1cm4gaW5kZXggPT09IDBcbiAgICAgICAgPyB0aGlzLl9wcm9ncmVzc0hhbmRsZXIwXG4gICAgICAgIDogdGhpc1soaW5kZXggPDwgMikgKyBpbmRleCAtIDUgKyAyXTtcbn07XG5cblByb21pc2UucHJvdG90eXBlLl9kb1Byb2dyZXNzV2l0aCA9XG5mdW5jdGlvbiBQcm9taXNlJF9kb1Byb2dyZXNzV2l0aChwcm9ncmVzc2lvbikge1xuICAgIHZhciBwcm9ncmVzc1ZhbHVlID0gcHJvZ3Jlc3Npb24udmFsdWU7XG4gICAgdmFyIGhhbmRsZXIgPSBwcm9ncmVzc2lvbi5oYW5kbGVyO1xuICAgIHZhciBwcm9taXNlID0gcHJvZ3Jlc3Npb24ucHJvbWlzZTtcbiAgICB2YXIgcmVjZWl2ZXIgPSBwcm9ncmVzc2lvbi5yZWNlaXZlcjtcblxuICAgIHZhciByZXQgPSB0cnlDYXRjaDEoaGFuZGxlciwgcmVjZWl2ZXIsIHByb2dyZXNzVmFsdWUpO1xuICAgIGlmIChyZXQgPT09IGVycm9yT2JqKSB7XG4gICAgICAgIGlmIChyZXQuZSAhPSBudWxsICYmXG4gICAgICAgICAgICByZXQuZS5uYW1lICE9PSBcIlN0b3BQcm9ncmVzc1Byb3BhZ2F0aW9uXCIpIHtcbiAgICAgICAgICAgIHZhciB0cmFjZSA9IGVycm9ycy5jYW5BdHRhY2gocmV0LmUpXG4gICAgICAgICAgICAgICAgPyByZXQuZSA6IG5ldyBFcnJvcihyZXQuZSArIFwiXCIpO1xuICAgICAgICAgICAgcHJvbWlzZS5fYXR0YWNoRXh0cmFUcmFjZSh0cmFjZSk7XG4gICAgICAgICAgICBwcm9taXNlLl9wcm9ncmVzcyhyZXQuZSk7XG4gICAgICAgIH1cbiAgICB9IGVsc2UgaWYgKHJldCBpbnN0YW5jZW9mIFByb21pc2UpIHtcbiAgICAgICAgcmV0Ll90aGVuKHByb21pc2UuX3Byb2dyZXNzLCBudWxsLCBudWxsLCBwcm9taXNlLCB2b2lkIDApO1xuICAgIH0gZWxzZSB7XG4gICAgICAgIHByb21pc2UuX3Byb2dyZXNzKHJldCk7XG4gICAgfVxufTtcblxuXG5Qcm9taXNlLnByb3RvdHlwZS5fcHJvZ3Jlc3NVbmNoZWNrZWQgPVxuZnVuY3Rpb24gUHJvbWlzZSRfcHJvZ3Jlc3NVbmNoZWNrZWQocHJvZ3Jlc3NWYWx1ZSkge1xuICAgIGlmICghdGhpcy5pc1BlbmRpbmcoKSkgcmV0dXJuO1xuICAgIHZhciBsZW4gPSB0aGlzLl9sZW5ndGgoKTtcbiAgICB2YXIgcHJvZ3Jlc3MgPSB0aGlzLl9wcm9ncmVzcztcbiAgICBmb3IgKHZhciBpID0gMDsgaSA8IGxlbjsgaSsrKSB7XG4gICAgICAgIHZhciBoYW5kbGVyID0gdGhpcy5fcHJvZ3Jlc3NIYW5kbGVyQXQoaSk7XG4gICAgICAgIHZhciBwcm9taXNlID0gdGhpcy5fcHJvbWlzZUF0KGkpO1xuICAgICAgICBpZiAoIShwcm9taXNlIGluc3RhbmNlb2YgUHJvbWlzZSkpIHtcbiAgICAgICAgICAgIHZhciByZWNlaXZlciA9IHRoaXMuX3JlY2VpdmVyQXQoaSk7XG4gICAgICAgICAgICBpZiAodHlwZW9mIGhhbmRsZXIgPT09IFwiZnVuY3Rpb25cIikge1xuICAgICAgICAgICAgICAgIGhhbmRsZXIuY2FsbChyZWNlaXZlciwgcHJvZ3Jlc3NWYWx1ZSwgcHJvbWlzZSk7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKHJlY2VpdmVyIGluc3RhbmNlb2YgUHJvbWlzZSAmJiByZWNlaXZlci5faXNQcm94aWVkKCkpIHtcbiAgICAgICAgICAgICAgICByZWNlaXZlci5fcHJvZ3Jlc3NVbmNoZWNrZWQocHJvZ3Jlc3NWYWx1ZSk7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKHJlY2VpdmVyIGluc3RhbmNlb2YgUHJvbWlzZUFycmF5KSB7XG4gICAgICAgICAgICAgICAgcmVjZWl2ZXIuX3Byb21pc2VQcm9ncmVzc2VkKHByb2dyZXNzVmFsdWUsIHByb21pc2UpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgY29udGludWU7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAodHlwZW9mIGhhbmRsZXIgPT09IFwiZnVuY3Rpb25cIikge1xuICAgICAgICAgICAgYXN5bmMuaW52b2tlKHRoaXMuX2RvUHJvZ3Jlc3NXaXRoLCB0aGlzLCB7XG4gICAgICAgICAgICAgICAgaGFuZGxlcjogaGFuZGxlcixcbiAgICAgICAgICAgICAgICBwcm9taXNlOiBwcm9taXNlLFxuICAgICAgICAgICAgICAgIHJlY2VpdmVyOiB0aGlzLl9yZWNlaXZlckF0KGkpLFxuICAgICAgICAgICAgICAgIHZhbHVlOiBwcm9ncmVzc1ZhbHVlXG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIGFzeW5jLmludm9rZShwcm9ncmVzcywgcHJvbWlzZSwgcHJvZ3Jlc3NWYWx1ZSk7XG4gICAgICAgIH1cbiAgICB9XG59O1xufTtcbiIsIi8qKlxuICogVGhlIE1JVCBMaWNlbnNlIChNSVQpXG4gKiBcbiAqIENvcHlyaWdodCAoYykgMjAxNCBQZXRrYSBBbnRvbm92XG4gKiBcbiAqIFBlcm1pc3Npb24gaXMgaGVyZWJ5IGdyYW50ZWQsIGZyZWUgb2YgY2hhcmdlLCB0byBhbnkgcGVyc29uIG9idGFpbmluZyBhIGNvcHlcbiAqIG9mIHRoaXMgc29mdHdhcmUgYW5kIGFzc29jaWF0ZWQgZG9jdW1lbnRhdGlvbiBmaWxlcyAodGhlIFwiU29mdHdhcmVcIiksIHRvIGRlYWxcbiAqIGluIHRoZSBTb2Z0d2FyZSB3aXRob3V0IHJlc3RyaWN0aW9uLCBpbmNsdWRpbmcgd2l0aG91dCBsaW1pdGF0aW9uIHRoZSByaWdodHNcbiAqIHRvIHVzZSwgY29weSwgbW9kaWZ5LCBtZXJnZSwgcHVibGlzaCwgZGlzdHJpYnV0ZSwgc3VibGljZW5zZSwgYW5kL29yIHNlbGxcbiAqIGNvcGllcyBvZiB0aGUgU29mdHdhcmUsIGFuZCB0byBwZXJtaXQgcGVyc29ucyB0byB3aG9tIHRoZSBTb2Z0d2FyZSBpc1xuICogZnVybmlzaGVkIHRvIGRvIHNvLCBzdWJqZWN0IHRvIHRoZSBmb2xsb3dpbmcgY29uZGl0aW9uczo8L3A+XG4gKiBcbiAqIFRoZSBhYm92ZSBjb3B5cmlnaHQgbm90aWNlIGFuZCB0aGlzIHBlcm1pc3Npb24gbm90aWNlIHNoYWxsIGJlIGluY2x1ZGVkIGluXG4gKiBhbGwgY29waWVzIG9yIHN1YnN0YW50aWFsIHBvcnRpb25zIG9mIHRoZSBTb2Z0d2FyZS5cbiAqIFxuICogVEhFIFNPRlRXQVJFIElTIFBST1ZJREVEIFwiQVMgSVNcIiwgV0lUSE9VVCBXQVJSQU5UWSBPRiBBTlkgS0lORCwgRVhQUkVTUyBPUlxuICogSU1QTElFRCwgSU5DTFVESU5HIEJVVCBOT1QgTElNSVRFRCBUTyBUSEUgV0FSUkFOVElFUyBPRiBNRVJDSEFOVEFCSUxJVFksXG4gKiBGSVRORVNTIEZPUiBBIFBBUlRJQ1VMQVIgUFVSUE9TRSBBTkQgTk9OSU5GUklOR0VNRU5ULiAgSU4gTk8gRVZFTlQgU0hBTEwgVEhFXG4gKiBBVVRIT1JTIE9SIENPUFlSSUdIVCBIT0xERVJTIEJFIExJQUJMRSBGT1IgQU5ZIENMQUlNLCBEQU1BR0VTIE9SIE9USEVSXG4gKiBMSUFCSUxJVFksIFdIRVRIRVIgSU4gQU4gQUNUSU9OIE9GIENPTlRSQUNULCBUT1JUIE9SIE9USEVSV0lTRSwgQVJJU0lORyBGUk9NLFxuICogT1VUIE9GIE9SIElOIENPTk5FQ1RJT04gV0lUSCBUSEUgU09GVFdBUkUgT1IgVEhFIFVTRSBPUiBPVEhFUiBERUFMSU5HUyBJTlxuICogVEhFIFNPRlRXQVJFLlxuICogXG4gKi9cblwidXNlIHN0cmljdFwiO1xudmFyIG9sZDtcbmlmICh0eXBlb2YgUHJvbWlzZSAhPT0gXCJ1bmRlZmluZWRcIikgb2xkID0gUHJvbWlzZTtcbmZ1bmN0aW9uIG5vQ29uZmxpY3QoYmx1ZWJpcmQpIHtcbiAgICB0cnkgeyBpZiAoUHJvbWlzZSA9PT0gYmx1ZWJpcmQpIFByb21pc2UgPSBvbGQ7IH1cbiAgICBjYXRjaCAoZSkge31cbiAgICByZXR1cm4gYmx1ZWJpcmQ7XG59XG5tb2R1bGUuZXhwb3J0cyA9IGZ1bmN0aW9uKCkge1xudmFyIHV0aWwgPSByZXF1aXJlKFwiLi91dGlsLmpzXCIpO1xudmFyIGFzeW5jID0gcmVxdWlyZShcIi4vYXN5bmMuanNcIik7XG52YXIgZXJyb3JzID0gcmVxdWlyZShcIi4vZXJyb3JzLmpzXCIpO1xuXG52YXIgSU5URVJOQUwgPSBmdW5jdGlvbigpe307XG52YXIgQVBQTFkgPSB7fTtcbnZhciBORVhUX0ZJTFRFUiA9IHtlOiBudWxsfTtcblxudmFyIGNhc3QgPSByZXF1aXJlKFwiLi90aGVuYWJsZXMuanNcIikoUHJvbWlzZSwgSU5URVJOQUwpO1xudmFyIFByb21pc2VBcnJheSA9IHJlcXVpcmUoXCIuL3Byb21pc2VfYXJyYXkuanNcIikoUHJvbWlzZSwgSU5URVJOQUwsIGNhc3QpO1xudmFyIENhcHR1cmVkVHJhY2UgPSByZXF1aXJlKFwiLi9jYXB0dXJlZF90cmFjZS5qc1wiKSgpO1xudmFyIENhdGNoRmlsdGVyID0gcmVxdWlyZShcIi4vY2F0Y2hfZmlsdGVyLmpzXCIpKE5FWFRfRklMVEVSKTtcbnZhciBQcm9taXNlUmVzb2x2ZXIgPSByZXF1aXJlKFwiLi9wcm9taXNlX3Jlc29sdmVyLmpzXCIpO1xuXG52YXIgaXNBcnJheSA9IHV0aWwuaXNBcnJheTtcblxudmFyIGVycm9yT2JqID0gdXRpbC5lcnJvck9iajtcbnZhciB0cnlDYXRjaDEgPSB1dGlsLnRyeUNhdGNoMTtcbnZhciB0cnlDYXRjaDIgPSB1dGlsLnRyeUNhdGNoMjtcbnZhciB0cnlDYXRjaEFwcGx5ID0gdXRpbC50cnlDYXRjaEFwcGx5O1xudmFyIFJhbmdlRXJyb3IgPSBlcnJvcnMuUmFuZ2VFcnJvcjtcbnZhciBUeXBlRXJyb3IgPSBlcnJvcnMuVHlwZUVycm9yO1xudmFyIENhbmNlbGxhdGlvbkVycm9yID0gZXJyb3JzLkNhbmNlbGxhdGlvbkVycm9yO1xudmFyIFRpbWVvdXRFcnJvciA9IGVycm9ycy5UaW1lb3V0RXJyb3I7XG52YXIgT3BlcmF0aW9uYWxFcnJvciA9IGVycm9ycy5PcGVyYXRpb25hbEVycm9yO1xudmFyIG9yaWdpbmF0ZXNGcm9tUmVqZWN0aW9uID0gZXJyb3JzLm9yaWdpbmF0ZXNGcm9tUmVqZWN0aW9uO1xudmFyIG1hcmtBc09yaWdpbmF0aW5nRnJvbVJlamVjdGlvbiA9IGVycm9ycy5tYXJrQXNPcmlnaW5hdGluZ0Zyb21SZWplY3Rpb247XG52YXIgY2FuQXR0YWNoID0gZXJyb3JzLmNhbkF0dGFjaDtcbnZhciB0aHJvd2VyID0gdXRpbC50aHJvd2VyO1xudmFyIGFwaVJlamVjdGlvbiA9IHJlcXVpcmUoXCIuL2Vycm9yc19hcGlfcmVqZWN0aW9uXCIpKFByb21pc2UpO1xuXG5cbnZhciBtYWtlU2VsZlJlc29sdXRpb25FcnJvciA9IGZ1bmN0aW9uIFByb21pc2UkX21ha2VTZWxmUmVzb2x1dGlvbkVycm9yKCkge1xuICAgIHJldHVybiBuZXcgVHlwZUVycm9yKFwiY2lyY3VsYXIgcHJvbWlzZSByZXNvbHV0aW9uIGNoYWluXCIpO1xufTtcblxuZnVuY3Rpb24gUHJvbWlzZShyZXNvbHZlcikge1xuICAgIGlmICh0eXBlb2YgcmVzb2x2ZXIgIT09IFwiZnVuY3Rpb25cIikge1xuICAgICAgICB0aHJvdyBuZXcgVHlwZUVycm9yKFwidGhlIHByb21pc2UgY29uc3RydWN0b3IgcmVxdWlyZXMgYSByZXNvbHZlciBmdW5jdGlvblwiKTtcbiAgICB9XG4gICAgaWYgKHRoaXMuY29uc3RydWN0b3IgIT09IFByb21pc2UpIHtcbiAgICAgICAgdGhyb3cgbmV3IFR5cGVFcnJvcihcInRoZSBwcm9taXNlIGNvbnN0cnVjdG9yIGNhbm5vdCBiZSBpbnZva2VkIGRpcmVjdGx5XCIpO1xuICAgIH1cbiAgICB0aGlzLl9iaXRGaWVsZCA9IDA7XG4gICAgdGhpcy5fZnVsZmlsbG1lbnRIYW5kbGVyMCA9IHZvaWQgMDtcbiAgICB0aGlzLl9yZWplY3Rpb25IYW5kbGVyMCA9IHZvaWQgMDtcbiAgICB0aGlzLl9wcm9taXNlMCA9IHZvaWQgMDtcbiAgICB0aGlzLl9yZWNlaXZlcjAgPSB2b2lkIDA7XG4gICAgdGhpcy5fc2V0dGxlZFZhbHVlID0gdm9pZCAwO1xuICAgIHRoaXMuX2JvdW5kVG8gPSB2b2lkIDA7XG4gICAgaWYgKHJlc29sdmVyICE9PSBJTlRFUk5BTCkgdGhpcy5fcmVzb2x2ZUZyb21SZXNvbHZlcihyZXNvbHZlcik7XG59XG5cbmZ1bmN0aW9uIHJldHVybkZpcnN0RWxlbWVudChlbGVtZW50cykge1xuICAgIHJldHVybiBlbGVtZW50c1swXTtcbn1cblxuUHJvbWlzZS5wcm90b3R5cGUuYmluZCA9IGZ1bmN0aW9uIFByb21pc2UkYmluZCh0aGlzQXJnKSB7XG4gICAgdmFyIG1heWJlUHJvbWlzZSA9IGNhc3QodGhpc0FyZywgdm9pZCAwKTtcbiAgICB2YXIgcmV0ID0gbmV3IFByb21pc2UoSU5URVJOQUwpO1xuICAgIGlmIChtYXliZVByb21pc2UgaW5zdGFuY2VvZiBQcm9taXNlKSB7XG4gICAgICAgIHZhciBiaW5kZXIgPSBtYXliZVByb21pc2UudGhlbihmdW5jdGlvbih0aGlzQXJnKSB7XG4gICAgICAgICAgICByZXQuX3NldEJvdW5kVG8odGhpc0FyZyk7XG4gICAgICAgIH0pO1xuICAgICAgICB2YXIgcCA9IFByb21pc2UuYWxsKFt0aGlzLCBiaW5kZXJdKS50aGVuKHJldHVybkZpcnN0RWxlbWVudCk7XG4gICAgICAgIHJldC5fZm9sbG93KHApO1xuICAgIH0gZWxzZSB7XG4gICAgICAgIHJldC5fZm9sbG93KHRoaXMpO1xuICAgICAgICByZXQuX3NldEJvdW5kVG8odGhpc0FyZyk7XG4gICAgfVxuICAgIHJldC5fcHJvcGFnYXRlRnJvbSh0aGlzLCAyIHwgMSk7XG4gICAgcmV0dXJuIHJldDtcbn07XG5cblByb21pc2UucHJvdG90eXBlLnRvU3RyaW5nID0gZnVuY3Rpb24gUHJvbWlzZSR0b1N0cmluZygpIHtcbiAgICByZXR1cm4gXCJbb2JqZWN0IFByb21pc2VdXCI7XG59O1xuXG5Qcm9taXNlLnByb3RvdHlwZS5jYXVnaHQgPSBQcm9taXNlLnByb3RvdHlwZVtcImNhdGNoXCJdID1cbmZ1bmN0aW9uIFByb21pc2UkY2F0Y2goZm4pIHtcbiAgICB2YXIgbGVuID0gYXJndW1lbnRzLmxlbmd0aDtcbiAgICBpZiAobGVuID4gMSkge1xuICAgICAgICB2YXIgY2F0Y2hJbnN0YW5jZXMgPSBuZXcgQXJyYXkobGVuIC0gMSksXG4gICAgICAgICAgICBqID0gMCwgaTtcbiAgICAgICAgZm9yIChpID0gMDsgaSA8IGxlbiAtIDE7ICsraSkge1xuICAgICAgICAgICAgdmFyIGl0ZW0gPSBhcmd1bWVudHNbaV07XG4gICAgICAgICAgICBpZiAodHlwZW9mIGl0ZW0gPT09IFwiZnVuY3Rpb25cIikge1xuICAgICAgICAgICAgICAgIGNhdGNoSW5zdGFuY2VzW2orK10gPSBpdGVtO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICB2YXIgY2F0Y2hGaWx0ZXJUeXBlRXJyb3IgPVxuICAgICAgICAgICAgICAgICAgICBuZXcgVHlwZUVycm9yKFxuICAgICAgICAgICAgICAgICAgICAgICAgXCJBIGNhdGNoIGZpbHRlciBtdXN0IGJlIGFuIGVycm9yIGNvbnN0cnVjdG9yIFwiXG4gICAgICAgICAgICAgICAgICAgICAgICArIFwib3IgYSBmaWx0ZXIgZnVuY3Rpb25cIik7XG5cbiAgICAgICAgICAgICAgICB0aGlzLl9hdHRhY2hFeHRyYVRyYWNlKGNhdGNoRmlsdGVyVHlwZUVycm9yKTtcbiAgICAgICAgICAgICAgICByZXR1cm4gUHJvbWlzZS5yZWplY3QoY2F0Y2hGaWx0ZXJUeXBlRXJyb3IpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICAgIGNhdGNoSW5zdGFuY2VzLmxlbmd0aCA9IGo7XG4gICAgICAgIGZuID0gYXJndW1lbnRzW2ldO1xuXG4gICAgICAgIHRoaXMuX3Jlc2V0VHJhY2UoKTtcbiAgICAgICAgdmFyIGNhdGNoRmlsdGVyID0gbmV3IENhdGNoRmlsdGVyKGNhdGNoSW5zdGFuY2VzLCBmbiwgdGhpcyk7XG4gICAgICAgIHJldHVybiB0aGlzLl90aGVuKHZvaWQgMCwgY2F0Y2hGaWx0ZXIuZG9GaWx0ZXIsIHZvaWQgMCxcbiAgICAgICAgICAgIGNhdGNoRmlsdGVyLCB2b2lkIDApO1xuICAgIH1cbiAgICByZXR1cm4gdGhpcy5fdGhlbih2b2lkIDAsIGZuLCB2b2lkIDAsIHZvaWQgMCwgdm9pZCAwKTtcbn07XG5cbmZ1bmN0aW9uIHJlZmxlY3QoKSB7XG4gICAgcmV0dXJuIG5ldyBQcm9taXNlLlByb21pc2VJbnNwZWN0aW9uKHRoaXMpO1xufVxuXG5Qcm9taXNlLnByb3RvdHlwZS5yZWZsZWN0ID0gZnVuY3Rpb24gUHJvbWlzZSRyZWZsZWN0KCkge1xuICAgIHJldHVybiB0aGlzLl90aGVuKHJlZmxlY3QsIHJlZmxlY3QsIHZvaWQgMCwgdGhpcywgdm9pZCAwKTtcbn07XG5cblByb21pc2UucHJvdG90eXBlLnRoZW4gPVxuZnVuY3Rpb24gUHJvbWlzZSR0aGVuKGRpZEZ1bGZpbGwsIGRpZFJlamVjdCwgZGlkUHJvZ3Jlc3MpIHtcbiAgICByZXR1cm4gdGhpcy5fdGhlbihkaWRGdWxmaWxsLCBkaWRSZWplY3QsIGRpZFByb2dyZXNzLFxuICAgICAgICB2b2lkIDAsIHZvaWQgMCk7XG59O1xuXG5cblByb21pc2UucHJvdG90eXBlLmRvbmUgPVxuZnVuY3Rpb24gUHJvbWlzZSRkb25lKGRpZEZ1bGZpbGwsIGRpZFJlamVjdCwgZGlkUHJvZ3Jlc3MpIHtcbiAgICB2YXIgcHJvbWlzZSA9IHRoaXMuX3RoZW4oZGlkRnVsZmlsbCwgZGlkUmVqZWN0LCBkaWRQcm9ncmVzcyxcbiAgICAgICAgdm9pZCAwLCB2b2lkIDApO1xuICAgIHByb21pc2UuX3NldElzRmluYWwoKTtcbn07XG5cblByb21pc2UucHJvdG90eXBlLnNwcmVhZCA9IGZ1bmN0aW9uIFByb21pc2Ukc3ByZWFkKGRpZEZ1bGZpbGwsIGRpZFJlamVjdCkge1xuICAgIHJldHVybiB0aGlzLl90aGVuKGRpZEZ1bGZpbGwsIGRpZFJlamVjdCwgdm9pZCAwLFxuICAgICAgICBBUFBMWSwgdm9pZCAwKTtcbn07XG5cblByb21pc2UucHJvdG90eXBlLmlzQ2FuY2VsbGFibGUgPSBmdW5jdGlvbiBQcm9taXNlJGlzQ2FuY2VsbGFibGUoKSB7XG4gICAgcmV0dXJuICF0aGlzLmlzUmVzb2x2ZWQoKSAmJlxuICAgICAgICB0aGlzLl9jYW5jZWxsYWJsZSgpO1xufTtcblxuUHJvbWlzZS5wcm90b3R5cGUudG9KU09OID0gZnVuY3Rpb24gUHJvbWlzZSR0b0pTT04oKSB7XG4gICAgdmFyIHJldCA9IHtcbiAgICAgICAgaXNGdWxmaWxsZWQ6IGZhbHNlLFxuICAgICAgICBpc1JlamVjdGVkOiBmYWxzZSxcbiAgICAgICAgZnVsZmlsbG1lbnRWYWx1ZTogdm9pZCAwLFxuICAgICAgICByZWplY3Rpb25SZWFzb246IHZvaWQgMFxuICAgIH07XG4gICAgaWYgKHRoaXMuaXNGdWxmaWxsZWQoKSkge1xuICAgICAgICByZXQuZnVsZmlsbG1lbnRWYWx1ZSA9IHRoaXMuX3NldHRsZWRWYWx1ZTtcbiAgICAgICAgcmV0LmlzRnVsZmlsbGVkID0gdHJ1ZTtcbiAgICB9IGVsc2UgaWYgKHRoaXMuaXNSZWplY3RlZCgpKSB7XG4gICAgICAgIHJldC5yZWplY3Rpb25SZWFzb24gPSB0aGlzLl9zZXR0bGVkVmFsdWU7XG4gICAgICAgIHJldC5pc1JlamVjdGVkID0gdHJ1ZTtcbiAgICB9XG4gICAgcmV0dXJuIHJldDtcbn07XG5cblByb21pc2UucHJvdG90eXBlLmFsbCA9IGZ1bmN0aW9uIFByb21pc2UkYWxsKCkge1xuICAgIHJldHVybiBuZXcgUHJvbWlzZUFycmF5KHRoaXMpLnByb21pc2UoKTtcbn07XG5cblxuUHJvbWlzZS5pcyA9IGZ1bmN0aW9uIFByb21pc2UkSXModmFsKSB7XG4gICAgcmV0dXJuIHZhbCBpbnN0YW5jZW9mIFByb21pc2U7XG59O1xuXG5Qcm9taXNlLmFsbCA9IGZ1bmN0aW9uIFByb21pc2UkQWxsKHByb21pc2VzKSB7XG4gICAgcmV0dXJuIG5ldyBQcm9taXNlQXJyYXkocHJvbWlzZXMpLnByb21pc2UoKTtcbn07XG5cblByb21pc2UucHJvdG90eXBlLmVycm9yID0gZnVuY3Rpb24gUHJvbWlzZSRfZXJyb3IoZm4pIHtcbiAgICByZXR1cm4gdGhpcy5jYXVnaHQob3JpZ2luYXRlc0Zyb21SZWplY3Rpb24sIGZuKTtcbn07XG5cblByb21pc2UucHJvdG90eXBlLl9yZXNvbHZlRnJvbVN5bmNWYWx1ZSA9XG5mdW5jdGlvbiBQcm9taXNlJF9yZXNvbHZlRnJvbVN5bmNWYWx1ZSh2YWx1ZSkge1xuICAgIGlmICh2YWx1ZSA9PT0gZXJyb3JPYmopIHtcbiAgICAgICAgdGhpcy5fY2xlYW5WYWx1ZXMoKTtcbiAgICAgICAgdGhpcy5fc2V0UmVqZWN0ZWQoKTtcbiAgICAgICAgdmFyIHJlYXNvbiA9IHZhbHVlLmU7XG4gICAgICAgIHRoaXMuX3NldHRsZWRWYWx1ZSA9IHJlYXNvbjtcbiAgICAgICAgdGhpcy5fdHJ5QXR0YWNoRXh0cmFUcmFjZShyZWFzb24pO1xuICAgICAgICB0aGlzLl9lbnN1cmVQb3NzaWJsZVJlamVjdGlvbkhhbmRsZWQoKTtcbiAgICB9IGVsc2Uge1xuICAgICAgICB2YXIgbWF5YmVQcm9taXNlID0gY2FzdCh2YWx1ZSwgdm9pZCAwKTtcbiAgICAgICAgaWYgKG1heWJlUHJvbWlzZSBpbnN0YW5jZW9mIFByb21pc2UpIHtcbiAgICAgICAgICAgIHRoaXMuX2ZvbGxvdyhtYXliZVByb21pc2UpO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgdGhpcy5fY2xlYW5WYWx1ZXMoKTtcbiAgICAgICAgICAgIHRoaXMuX3NldEZ1bGZpbGxlZCgpO1xuICAgICAgICAgICAgdGhpcy5fc2V0dGxlZFZhbHVlID0gdmFsdWU7XG4gICAgICAgIH1cbiAgICB9XG59O1xuXG5Qcm9taXNlLm1ldGhvZCA9IGZ1bmN0aW9uIFByb21pc2UkX01ldGhvZChmbikge1xuICAgIGlmICh0eXBlb2YgZm4gIT09IFwiZnVuY3Rpb25cIikge1xuICAgICAgICB0aHJvdyBuZXcgVHlwZUVycm9yKFwiZm4gbXVzdCBiZSBhIGZ1bmN0aW9uXCIpO1xuICAgIH1cbiAgICByZXR1cm4gZnVuY3Rpb24gUHJvbWlzZSRfbWV0aG9kKCkge1xuICAgICAgICB2YXIgdmFsdWU7XG4gICAgICAgIHN3aXRjaChhcmd1bWVudHMubGVuZ3RoKSB7XG4gICAgICAgIGNhc2UgMDogdmFsdWUgPSB0cnlDYXRjaDEoZm4sIHRoaXMsIHZvaWQgMCk7IGJyZWFrO1xuICAgICAgICBjYXNlIDE6IHZhbHVlID0gdHJ5Q2F0Y2gxKGZuLCB0aGlzLCBhcmd1bWVudHNbMF0pOyBicmVhaztcbiAgICAgICAgY2FzZSAyOiB2YWx1ZSA9IHRyeUNhdGNoMihmbiwgdGhpcywgYXJndW1lbnRzWzBdLCBhcmd1bWVudHNbMV0pOyBicmVhaztcbiAgICAgICAgZGVmYXVsdDpcbiAgICAgICAgICAgIHZhciAkX2xlbiA9IGFyZ3VtZW50cy5sZW5ndGg7dmFyIGFyZ3MgPSBuZXcgQXJyYXkoJF9sZW4pOyBmb3IodmFyICRfaSA9IDA7ICRfaSA8ICRfbGVuOyArKyRfaSkge2FyZ3NbJF9pXSA9IGFyZ3VtZW50c1skX2ldO31cbiAgICAgICAgICAgIHZhbHVlID0gdHJ5Q2F0Y2hBcHBseShmbiwgYXJncywgdGhpcyk7IGJyZWFrO1xuICAgICAgICB9XG4gICAgICAgIHZhciByZXQgPSBuZXcgUHJvbWlzZShJTlRFUk5BTCk7XG4gICAgICAgIHJldC5fc2V0VHJhY2Uodm9pZCAwKTtcbiAgICAgICAgcmV0Ll9yZXNvbHZlRnJvbVN5bmNWYWx1ZSh2YWx1ZSk7XG4gICAgICAgIHJldHVybiByZXQ7XG4gICAgfTtcbn07XG5cblByb21pc2UuYXR0ZW1wdCA9IFByb21pc2VbXCJ0cnlcIl0gPSBmdW5jdGlvbiBQcm9taXNlJF9UcnkoZm4sIGFyZ3MsIGN0eCkge1xuICAgIGlmICh0eXBlb2YgZm4gIT09IFwiZnVuY3Rpb25cIikge1xuICAgICAgICByZXR1cm4gYXBpUmVqZWN0aW9uKFwiZm4gbXVzdCBiZSBhIGZ1bmN0aW9uXCIpO1xuICAgIH1cbiAgICB2YXIgdmFsdWUgPSBpc0FycmF5KGFyZ3MpXG4gICAgICAgID8gdHJ5Q2F0Y2hBcHBseShmbiwgYXJncywgY3R4KVxuICAgICAgICA6IHRyeUNhdGNoMShmbiwgY3R4LCBhcmdzKTtcblxuICAgIHZhciByZXQgPSBuZXcgUHJvbWlzZShJTlRFUk5BTCk7XG4gICAgcmV0Ll9zZXRUcmFjZSh2b2lkIDApO1xuICAgIHJldC5fcmVzb2x2ZUZyb21TeW5jVmFsdWUodmFsdWUpO1xuICAgIHJldHVybiByZXQ7XG59O1xuXG5Qcm9taXNlLmRlZmVyID0gUHJvbWlzZS5wZW5kaW5nID0gZnVuY3Rpb24gUHJvbWlzZSREZWZlcigpIHtcbiAgICB2YXIgcHJvbWlzZSA9IG5ldyBQcm9taXNlKElOVEVSTkFMKTtcbiAgICBwcm9taXNlLl9zZXRUcmFjZSh2b2lkIDApO1xuICAgIHJldHVybiBuZXcgUHJvbWlzZVJlc29sdmVyKHByb21pc2UpO1xufTtcblxuUHJvbWlzZS5iaW5kID0gZnVuY3Rpb24gUHJvbWlzZSRCaW5kKHRoaXNBcmcpIHtcbiAgICB2YXIgbWF5YmVQcm9taXNlID0gY2FzdCh0aGlzQXJnLCB2b2lkIDApO1xuICAgIHZhciByZXQgPSBuZXcgUHJvbWlzZShJTlRFUk5BTCk7XG4gICAgcmV0Ll9zZXRUcmFjZSh2b2lkIDApO1xuXG4gICAgaWYgKG1heWJlUHJvbWlzZSBpbnN0YW5jZW9mIFByb21pc2UpIHtcbiAgICAgICAgdmFyIHAgPSBtYXliZVByb21pc2UudGhlbihmdW5jdGlvbih0aGlzQXJnKSB7XG4gICAgICAgICAgICByZXQuX3NldEJvdW5kVG8odGhpc0FyZyk7XG4gICAgICAgIH0pO1xuICAgICAgICByZXQuX2ZvbGxvdyhwKTtcbiAgICB9IGVsc2Uge1xuICAgICAgICByZXQuX3NldEJvdW5kVG8odGhpc0FyZyk7XG4gICAgICAgIHJldC5fc2V0RnVsZmlsbGVkKCk7XG4gICAgfVxuICAgIHJldHVybiByZXQ7XG59O1xuXG5Qcm9taXNlLmNhc3QgPSBmdW5jdGlvbiBQcm9taXNlJF9DYXN0KG9iaikge1xuICAgIHZhciByZXQgPSBjYXN0KG9iaiwgdm9pZCAwKTtcbiAgICBpZiAoIShyZXQgaW5zdGFuY2VvZiBQcm9taXNlKSkge1xuICAgICAgICB2YXIgdmFsID0gcmV0O1xuICAgICAgICByZXQgPSBuZXcgUHJvbWlzZShJTlRFUk5BTCk7XG4gICAgICAgIHJldC5fc2V0VHJhY2Uodm9pZCAwKTtcbiAgICAgICAgcmV0Ll9zZXRGdWxmaWxsZWQoKTtcbiAgICAgICAgcmV0Ll9jbGVhblZhbHVlcygpO1xuICAgICAgICByZXQuX3NldHRsZWRWYWx1ZSA9IHZhbDtcbiAgICB9XG4gICAgcmV0dXJuIHJldDtcbn07XG5cblByb21pc2UucmVzb2x2ZSA9IFByb21pc2UuZnVsZmlsbGVkID0gUHJvbWlzZS5jYXN0O1xuXG5Qcm9taXNlLnJlamVjdCA9IFByb21pc2UucmVqZWN0ZWQgPSBmdW5jdGlvbiBQcm9taXNlJFJlamVjdChyZWFzb24pIHtcbiAgICB2YXIgcmV0ID0gbmV3IFByb21pc2UoSU5URVJOQUwpO1xuICAgIHJldC5fc2V0VHJhY2Uodm9pZCAwKTtcbiAgICBtYXJrQXNPcmlnaW5hdGluZ0Zyb21SZWplY3Rpb24ocmVhc29uKTtcbiAgICByZXQuX2NsZWFuVmFsdWVzKCk7XG4gICAgcmV0Ll9zZXRSZWplY3RlZCgpO1xuICAgIHJldC5fc2V0dGxlZFZhbHVlID0gcmVhc29uO1xuICAgIGlmICghY2FuQXR0YWNoKHJlYXNvbikpIHtcbiAgICAgICAgdmFyIHRyYWNlID0gbmV3IEVycm9yKHJlYXNvbiArIFwiXCIpO1xuICAgICAgICByZXQuX3NldENhcnJpZWRTdGFja1RyYWNlKHRyYWNlKTtcbiAgICB9XG4gICAgcmV0Ll9lbnN1cmVQb3NzaWJsZVJlamVjdGlvbkhhbmRsZWQoKTtcbiAgICByZXR1cm4gcmV0O1xufTtcblxuUHJvbWlzZS5vblBvc3NpYmx5VW5oYW5kbGVkUmVqZWN0aW9uID1cbmZ1bmN0aW9uIFByb21pc2UkT25Qb3NzaWJseVVuaGFuZGxlZFJlamVjdGlvbihmbikge1xuICAgICAgICBDYXB0dXJlZFRyYWNlLnBvc3NpYmx5VW5oYW5kbGVkUmVqZWN0aW9uID0gdHlwZW9mIGZuID09PSBcImZ1bmN0aW9uXCJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICA/IGZuIDogdm9pZCAwO1xufTtcblxudmFyIHVuaGFuZGxlZFJlamVjdGlvbkhhbmRsZWQ7XG5Qcm9taXNlLm9uVW5oYW5kbGVkUmVqZWN0aW9uSGFuZGxlZCA9XG5mdW5jdGlvbiBQcm9taXNlJG9uVW5oYW5kbGVkUmVqZWN0aW9uSGFuZGxlZChmbikge1xuICAgIHVuaGFuZGxlZFJlamVjdGlvbkhhbmRsZWQgPSB0eXBlb2YgZm4gPT09IFwiZnVuY3Rpb25cIiA/IGZuIDogdm9pZCAwO1xufTtcblxudmFyIGRlYnVnZ2luZyA9IGZhbHNlIHx8ICEhKFxuICAgIHR5cGVvZiBwcm9jZXNzICE9PSBcInVuZGVmaW5lZFwiICYmXG4gICAgdHlwZW9mIHByb2Nlc3MuZXhlY1BhdGggPT09IFwic3RyaW5nXCIgJiZcbiAgICB0eXBlb2YgcHJvY2Vzcy5lbnYgPT09IFwib2JqZWN0XCIgJiZcbiAgICAocHJvY2Vzcy5lbnZbXCJCTFVFQklSRF9ERUJVR1wiXSB8fFxuICAgICAgICBwcm9jZXNzLmVudltcIk5PREVfRU5WXCJdID09PSBcImRldmVsb3BtZW50XCIpXG4pO1xuXG5cblByb21pc2UubG9uZ1N0YWNrVHJhY2VzID0gZnVuY3Rpb24gUHJvbWlzZSRMb25nU3RhY2tUcmFjZXMoKSB7XG4gICAgaWYgKGFzeW5jLmhhdmVJdGVtc1F1ZXVlZCgpICYmXG4gICAgICAgIGRlYnVnZ2luZyA9PT0gZmFsc2VcbiAgICkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoXCJjYW5ub3QgZW5hYmxlIGxvbmcgc3RhY2sgdHJhY2VzIGFmdGVyIHByb21pc2VzIGhhdmUgYmVlbiBjcmVhdGVkXCIpO1xuICAgIH1cbiAgICBkZWJ1Z2dpbmcgPSBDYXB0dXJlZFRyYWNlLmlzU3VwcG9ydGVkKCk7XG59O1xuXG5Qcm9taXNlLmhhc0xvbmdTdGFja1RyYWNlcyA9IGZ1bmN0aW9uIFByb21pc2UkSGFzTG9uZ1N0YWNrVHJhY2VzKCkge1xuICAgIHJldHVybiBkZWJ1Z2dpbmcgJiYgQ2FwdHVyZWRUcmFjZS5pc1N1cHBvcnRlZCgpO1xufTtcblxuUHJvbWlzZS5wcm90b3R5cGUuX3RoZW4gPVxuZnVuY3Rpb24gUHJvbWlzZSRfdGhlbihcbiAgICBkaWRGdWxmaWxsLFxuICAgIGRpZFJlamVjdCxcbiAgICBkaWRQcm9ncmVzcyxcbiAgICByZWNlaXZlcixcbiAgICBpbnRlcm5hbERhdGFcbikge1xuICAgIHZhciBoYXZlSW50ZXJuYWxEYXRhID0gaW50ZXJuYWxEYXRhICE9PSB2b2lkIDA7XG4gICAgdmFyIHJldCA9IGhhdmVJbnRlcm5hbERhdGEgPyBpbnRlcm5hbERhdGEgOiBuZXcgUHJvbWlzZShJTlRFUk5BTCk7XG5cbiAgICBpZiAoIWhhdmVJbnRlcm5hbERhdGEpIHtcbiAgICAgICAgaWYgKGRlYnVnZ2luZykge1xuICAgICAgICAgICAgdmFyIGhhdmVTYW1lQ29udGV4dCA9IHRoaXMuX3BlZWtDb250ZXh0KCkgPT09IHRoaXMuX3RyYWNlUGFyZW50O1xuICAgICAgICAgICAgcmV0Ll90cmFjZVBhcmVudCA9IGhhdmVTYW1lQ29udGV4dCA/IHRoaXMuX3RyYWNlUGFyZW50IDogdGhpcztcbiAgICAgICAgfVxuICAgICAgICByZXQuX3Byb3BhZ2F0ZUZyb20odGhpcywgNyk7XG4gICAgfVxuXG4gICAgdmFyIGNhbGxiYWNrSW5kZXggPVxuICAgICAgICB0aGlzLl9hZGRDYWxsYmFja3MoZGlkRnVsZmlsbCwgZGlkUmVqZWN0LCBkaWRQcm9ncmVzcywgcmV0LCByZWNlaXZlcik7XG5cbiAgICBpZiAodGhpcy5pc1Jlc29sdmVkKCkpIHtcbiAgICAgICAgYXN5bmMuaW52b2tlKHRoaXMuX3F1ZXVlU2V0dGxlQXQsIHRoaXMsIGNhbGxiYWNrSW5kZXgpO1xuICAgIH1cblxuICAgIHJldHVybiByZXQ7XG59O1xuXG5Qcm9taXNlLnByb3RvdHlwZS5fbGVuZ3RoID0gZnVuY3Rpb24gUHJvbWlzZSRfbGVuZ3RoKCkge1xuICAgIHJldHVybiB0aGlzLl9iaXRGaWVsZCAmIDI2MjE0Mztcbn07XG5cblByb21pc2UucHJvdG90eXBlLl9pc0ZvbGxvd2luZ09yRnVsZmlsbGVkT3JSZWplY3RlZCA9XG5mdW5jdGlvbiBQcm9taXNlJF9pc0ZvbGxvd2luZ09yRnVsZmlsbGVkT3JSZWplY3RlZCgpIHtcbiAgICByZXR1cm4gKHRoaXMuX2JpdEZpZWxkICYgOTM5NTI0MDk2KSA+IDA7XG59O1xuXG5Qcm9taXNlLnByb3RvdHlwZS5faXNGb2xsb3dpbmcgPSBmdW5jdGlvbiBQcm9taXNlJF9pc0ZvbGxvd2luZygpIHtcbiAgICByZXR1cm4gKHRoaXMuX2JpdEZpZWxkICYgNTM2ODcwOTEyKSA9PT0gNTM2ODcwOTEyO1xufTtcblxuUHJvbWlzZS5wcm90b3R5cGUuX3NldExlbmd0aCA9IGZ1bmN0aW9uIFByb21pc2UkX3NldExlbmd0aChsZW4pIHtcbiAgICB0aGlzLl9iaXRGaWVsZCA9ICh0aGlzLl9iaXRGaWVsZCAmIC0yNjIxNDQpIHxcbiAgICAgICAgKGxlbiAmIDI2MjE0Myk7XG59O1xuXG5Qcm9taXNlLnByb3RvdHlwZS5fc2V0RnVsZmlsbGVkID0gZnVuY3Rpb24gUHJvbWlzZSRfc2V0RnVsZmlsbGVkKCkge1xuICAgIHRoaXMuX2JpdEZpZWxkID0gdGhpcy5fYml0RmllbGQgfCAyNjg0MzU0NTY7XG59O1xuXG5Qcm9taXNlLnByb3RvdHlwZS5fc2V0UmVqZWN0ZWQgPSBmdW5jdGlvbiBQcm9taXNlJF9zZXRSZWplY3RlZCgpIHtcbiAgICB0aGlzLl9iaXRGaWVsZCA9IHRoaXMuX2JpdEZpZWxkIHwgMTM0MjE3NzI4O1xufTtcblxuUHJvbWlzZS5wcm90b3R5cGUuX3NldEZvbGxvd2luZyA9IGZ1bmN0aW9uIFByb21pc2UkX3NldEZvbGxvd2luZygpIHtcbiAgICB0aGlzLl9iaXRGaWVsZCA9IHRoaXMuX2JpdEZpZWxkIHwgNTM2ODcwOTEyO1xufTtcblxuUHJvbWlzZS5wcm90b3R5cGUuX3NldElzRmluYWwgPSBmdW5jdGlvbiBQcm9taXNlJF9zZXRJc0ZpbmFsKCkge1xuICAgIHRoaXMuX2JpdEZpZWxkID0gdGhpcy5fYml0RmllbGQgfCAzMzU1NDQzMjtcbn07XG5cblByb21pc2UucHJvdG90eXBlLl9pc0ZpbmFsID0gZnVuY3Rpb24gUHJvbWlzZSRfaXNGaW5hbCgpIHtcbiAgICByZXR1cm4gKHRoaXMuX2JpdEZpZWxkICYgMzM1NTQ0MzIpID4gMDtcbn07XG5cblByb21pc2UucHJvdG90eXBlLl9jYW5jZWxsYWJsZSA9IGZ1bmN0aW9uIFByb21pc2UkX2NhbmNlbGxhYmxlKCkge1xuICAgIHJldHVybiAodGhpcy5fYml0RmllbGQgJiA2NzEwODg2NCkgPiAwO1xufTtcblxuUHJvbWlzZS5wcm90b3R5cGUuX3NldENhbmNlbGxhYmxlID0gZnVuY3Rpb24gUHJvbWlzZSRfc2V0Q2FuY2VsbGFibGUoKSB7XG4gICAgdGhpcy5fYml0RmllbGQgPSB0aGlzLl9iaXRGaWVsZCB8IDY3MTA4ODY0O1xufTtcblxuUHJvbWlzZS5wcm90b3R5cGUuX3Vuc2V0Q2FuY2VsbGFibGUgPSBmdW5jdGlvbiBQcm9taXNlJF91bnNldENhbmNlbGxhYmxlKCkge1xuICAgIHRoaXMuX2JpdEZpZWxkID0gdGhpcy5fYml0RmllbGQgJiAofjY3MTA4ODY0KTtcbn07XG5cblByb21pc2UucHJvdG90eXBlLl9zZXRSZWplY3Rpb25Jc1VuaGFuZGxlZCA9XG5mdW5jdGlvbiBQcm9taXNlJF9zZXRSZWplY3Rpb25Jc1VuaGFuZGxlZCgpIHtcbiAgICB0aGlzLl9iaXRGaWVsZCA9IHRoaXMuX2JpdEZpZWxkIHwgMjA5NzE1Mjtcbn07XG5cblByb21pc2UucHJvdG90eXBlLl91bnNldFJlamVjdGlvbklzVW5oYW5kbGVkID1cbmZ1bmN0aW9uIFByb21pc2UkX3Vuc2V0UmVqZWN0aW9uSXNVbmhhbmRsZWQoKSB7XG4gICAgdGhpcy5fYml0RmllbGQgPSB0aGlzLl9iaXRGaWVsZCAmICh+MjA5NzE1Mik7XG4gICAgaWYgKHRoaXMuX2lzVW5oYW5kbGVkUmVqZWN0aW9uTm90aWZpZWQoKSkge1xuICAgICAgICB0aGlzLl91bnNldFVuaGFuZGxlZFJlamVjdGlvbklzTm90aWZpZWQoKTtcbiAgICAgICAgdGhpcy5fbm90aWZ5VW5oYW5kbGVkUmVqZWN0aW9uSXNIYW5kbGVkKCk7XG4gICAgfVxufTtcblxuUHJvbWlzZS5wcm90b3R5cGUuX2lzUmVqZWN0aW9uVW5oYW5kbGVkID1cbmZ1bmN0aW9uIFByb21pc2UkX2lzUmVqZWN0aW9uVW5oYW5kbGVkKCkge1xuICAgIHJldHVybiAodGhpcy5fYml0RmllbGQgJiAyMDk3MTUyKSA+IDA7XG59O1xuXG5Qcm9taXNlLnByb3RvdHlwZS5fc2V0VW5oYW5kbGVkUmVqZWN0aW9uSXNOb3RpZmllZCA9XG5mdW5jdGlvbiBQcm9taXNlJF9zZXRVbmhhbmRsZWRSZWplY3Rpb25Jc05vdGlmaWVkKCkge1xuICAgIHRoaXMuX2JpdEZpZWxkID0gdGhpcy5fYml0RmllbGQgfCA1MjQyODg7XG59O1xuXG5Qcm9taXNlLnByb3RvdHlwZS5fdW5zZXRVbmhhbmRsZWRSZWplY3Rpb25Jc05vdGlmaWVkID1cbmZ1bmN0aW9uIFByb21pc2UkX3Vuc2V0VW5oYW5kbGVkUmVqZWN0aW9uSXNOb3RpZmllZCgpIHtcbiAgICB0aGlzLl9iaXRGaWVsZCA9IHRoaXMuX2JpdEZpZWxkICYgKH41MjQyODgpO1xufTtcblxuUHJvbWlzZS5wcm90b3R5cGUuX2lzVW5oYW5kbGVkUmVqZWN0aW9uTm90aWZpZWQgPVxuZnVuY3Rpb24gUHJvbWlzZSRfaXNVbmhhbmRsZWRSZWplY3Rpb25Ob3RpZmllZCgpIHtcbiAgICByZXR1cm4gKHRoaXMuX2JpdEZpZWxkICYgNTI0Mjg4KSA+IDA7XG59O1xuXG5Qcm9taXNlLnByb3RvdHlwZS5fc2V0Q2FycmllZFN0YWNrVHJhY2UgPVxuZnVuY3Rpb24gUHJvbWlzZSRfc2V0Q2FycmllZFN0YWNrVHJhY2UoY2FwdHVyZWRUcmFjZSkge1xuICAgIHRoaXMuX2JpdEZpZWxkID0gdGhpcy5fYml0RmllbGQgfCAxMDQ4NTc2O1xuICAgIHRoaXMuX2Z1bGZpbGxtZW50SGFuZGxlcjAgPSBjYXB0dXJlZFRyYWNlO1xufTtcblxuUHJvbWlzZS5wcm90b3R5cGUuX3Vuc2V0Q2FycmllZFN0YWNrVHJhY2UgPVxuZnVuY3Rpb24gUHJvbWlzZSRfdW5zZXRDYXJyaWVkU3RhY2tUcmFjZSgpIHtcbiAgICB0aGlzLl9iaXRGaWVsZCA9IHRoaXMuX2JpdEZpZWxkICYgKH4xMDQ4NTc2KTtcbiAgICB0aGlzLl9mdWxmaWxsbWVudEhhbmRsZXIwID0gdm9pZCAwO1xufTtcblxuUHJvbWlzZS5wcm90b3R5cGUuX2lzQ2FycnlpbmdTdGFja1RyYWNlID1cbmZ1bmN0aW9uIFByb21pc2UkX2lzQ2FycnlpbmdTdGFja1RyYWNlKCkge1xuICAgIHJldHVybiAodGhpcy5fYml0RmllbGQgJiAxMDQ4NTc2KSA+IDA7XG59O1xuXG5Qcm9taXNlLnByb3RvdHlwZS5fZ2V0Q2FycmllZFN0YWNrVHJhY2UgPVxuZnVuY3Rpb24gUHJvbWlzZSRfZ2V0Q2FycmllZFN0YWNrVHJhY2UoKSB7XG4gICAgcmV0dXJuIHRoaXMuX2lzQ2FycnlpbmdTdGFja1RyYWNlKClcbiAgICAgICAgPyB0aGlzLl9mdWxmaWxsbWVudEhhbmRsZXIwXG4gICAgICAgIDogdm9pZCAwO1xufTtcblxuUHJvbWlzZS5wcm90b3R5cGUuX3JlY2VpdmVyQXQgPSBmdW5jdGlvbiBQcm9taXNlJF9yZWNlaXZlckF0KGluZGV4KSB7XG4gICAgdmFyIHJldCA9IGluZGV4ID09PSAwXG4gICAgICAgID8gdGhpcy5fcmVjZWl2ZXIwXG4gICAgICAgIDogdGhpc1soaW5kZXggPDwgMikgKyBpbmRleCAtIDUgKyA0XTtcbiAgICBpZiAodGhpcy5faXNCb3VuZCgpICYmIHJldCA9PT0gdm9pZCAwKSB7XG4gICAgICAgIHJldHVybiB0aGlzLl9ib3VuZFRvO1xuICAgIH1cbiAgICByZXR1cm4gcmV0O1xufTtcblxuUHJvbWlzZS5wcm90b3R5cGUuX3Byb21pc2VBdCA9IGZ1bmN0aW9uIFByb21pc2UkX3Byb21pc2VBdChpbmRleCkge1xuICAgIHJldHVybiBpbmRleCA9PT0gMFxuICAgICAgICA/IHRoaXMuX3Byb21pc2UwXG4gICAgICAgIDogdGhpc1soaW5kZXggPDwgMikgKyBpbmRleCAtIDUgKyAzXTtcbn07XG5cblByb21pc2UucHJvdG90eXBlLl9mdWxmaWxsbWVudEhhbmRsZXJBdCA9XG5mdW5jdGlvbiBQcm9taXNlJF9mdWxmaWxsbWVudEhhbmRsZXJBdChpbmRleCkge1xuICAgIHJldHVybiBpbmRleCA9PT0gMFxuICAgICAgICA/IHRoaXMuX2Z1bGZpbGxtZW50SGFuZGxlcjBcbiAgICAgICAgOiB0aGlzWyhpbmRleCA8PCAyKSArIGluZGV4IC0gNSArIDBdO1xufTtcblxuUHJvbWlzZS5wcm90b3R5cGUuX3JlamVjdGlvbkhhbmRsZXJBdCA9XG5mdW5jdGlvbiBQcm9taXNlJF9yZWplY3Rpb25IYW5kbGVyQXQoaW5kZXgpIHtcbiAgICByZXR1cm4gaW5kZXggPT09IDBcbiAgICAgICAgPyB0aGlzLl9yZWplY3Rpb25IYW5kbGVyMFxuICAgICAgICA6IHRoaXNbKGluZGV4IDw8IDIpICsgaW5kZXggLSA1ICsgMV07XG59O1xuXG5Qcm9taXNlLnByb3RvdHlwZS5fYWRkQ2FsbGJhY2tzID0gZnVuY3Rpb24gUHJvbWlzZSRfYWRkQ2FsbGJhY2tzKFxuICAgIGZ1bGZpbGwsXG4gICAgcmVqZWN0LFxuICAgIHByb2dyZXNzLFxuICAgIHByb21pc2UsXG4gICAgcmVjZWl2ZXJcbikge1xuICAgIHZhciBpbmRleCA9IHRoaXMuX2xlbmd0aCgpO1xuXG4gICAgaWYgKGluZGV4ID49IDI2MjE0MyAtIDUpIHtcbiAgICAgICAgaW5kZXggPSAwO1xuICAgICAgICB0aGlzLl9zZXRMZW5ndGgoMCk7XG4gICAgfVxuXG4gICAgaWYgKGluZGV4ID09PSAwKSB7XG4gICAgICAgIHRoaXMuX3Byb21pc2UwID0gcHJvbWlzZTtcbiAgICAgICAgaWYgKHJlY2VpdmVyICE9PSB2b2lkIDApIHRoaXMuX3JlY2VpdmVyMCA9IHJlY2VpdmVyO1xuICAgICAgICBpZiAodHlwZW9mIGZ1bGZpbGwgPT09IFwiZnVuY3Rpb25cIiAmJiAhdGhpcy5faXNDYXJyeWluZ1N0YWNrVHJhY2UoKSlcbiAgICAgICAgICAgIHRoaXMuX2Z1bGZpbGxtZW50SGFuZGxlcjAgPSBmdWxmaWxsO1xuICAgICAgICBpZiAodHlwZW9mIHJlamVjdCA9PT0gXCJmdW5jdGlvblwiKSB0aGlzLl9yZWplY3Rpb25IYW5kbGVyMCA9IHJlamVjdDtcbiAgICAgICAgaWYgKHR5cGVvZiBwcm9ncmVzcyA9PT0gXCJmdW5jdGlvblwiKSB0aGlzLl9wcm9ncmVzc0hhbmRsZXIwID0gcHJvZ3Jlc3M7XG4gICAgfSBlbHNlIHtcbiAgICAgICAgdmFyIGJhc2UgPSAoaW5kZXggPDwgMikgKyBpbmRleCAtIDU7XG4gICAgICAgIHRoaXNbYmFzZSArIDNdID0gcHJvbWlzZTtcbiAgICAgICAgdGhpc1tiYXNlICsgNF0gPSByZWNlaXZlcjtcbiAgICAgICAgdGhpc1tiYXNlICsgMF0gPSB0eXBlb2YgZnVsZmlsbCA9PT0gXCJmdW5jdGlvblwiXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgID8gZnVsZmlsbCA6IHZvaWQgMDtcbiAgICAgICAgdGhpc1tiYXNlICsgMV0gPSB0eXBlb2YgcmVqZWN0ID09PSBcImZ1bmN0aW9uXCJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgPyByZWplY3QgOiB2b2lkIDA7XG4gICAgICAgIHRoaXNbYmFzZSArIDJdID0gdHlwZW9mIHByb2dyZXNzID09PSBcImZ1bmN0aW9uXCJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgPyBwcm9ncmVzcyA6IHZvaWQgMDtcbiAgICB9XG4gICAgdGhpcy5fc2V0TGVuZ3RoKGluZGV4ICsgMSk7XG4gICAgcmV0dXJuIGluZGV4O1xufTtcblxuUHJvbWlzZS5wcm90b3R5cGUuX3NldFByb3h5SGFuZGxlcnMgPVxuZnVuY3Rpb24gUHJvbWlzZSRfc2V0UHJveHlIYW5kbGVycyhyZWNlaXZlciwgcHJvbWlzZVNsb3RWYWx1ZSkge1xuICAgIHZhciBpbmRleCA9IHRoaXMuX2xlbmd0aCgpO1xuXG4gICAgaWYgKGluZGV4ID49IDI2MjE0MyAtIDUpIHtcbiAgICAgICAgaW5kZXggPSAwO1xuICAgICAgICB0aGlzLl9zZXRMZW5ndGgoMCk7XG4gICAgfVxuICAgIGlmIChpbmRleCA9PT0gMCkge1xuICAgICAgICB0aGlzLl9wcm9taXNlMCA9IHByb21pc2VTbG90VmFsdWU7XG4gICAgICAgIHRoaXMuX3JlY2VpdmVyMCA9IHJlY2VpdmVyO1xuICAgIH0gZWxzZSB7XG4gICAgICAgIHZhciBiYXNlID0gKGluZGV4IDw8IDIpICsgaW5kZXggLSA1O1xuICAgICAgICB0aGlzW2Jhc2UgKyAzXSA9IHByb21pc2VTbG90VmFsdWU7XG4gICAgICAgIHRoaXNbYmFzZSArIDRdID0gcmVjZWl2ZXI7XG4gICAgICAgIHRoaXNbYmFzZSArIDBdID1cbiAgICAgICAgdGhpc1tiYXNlICsgMV0gPVxuICAgICAgICB0aGlzW2Jhc2UgKyAyXSA9IHZvaWQgMDtcbiAgICB9XG4gICAgdGhpcy5fc2V0TGVuZ3RoKGluZGV4ICsgMSk7XG59O1xuXG5Qcm9taXNlLnByb3RvdHlwZS5fcHJveHlQcm9taXNlQXJyYXkgPVxuZnVuY3Rpb24gUHJvbWlzZSRfcHJveHlQcm9taXNlQXJyYXkocHJvbWlzZUFycmF5LCBpbmRleCkge1xuICAgIHRoaXMuX3NldFByb3h5SGFuZGxlcnMocHJvbWlzZUFycmF5LCBpbmRleCk7XG59O1xuXG5Qcm9taXNlLnByb3RvdHlwZS5fcHJveHlQcm9taXNlID0gZnVuY3Rpb24gUHJvbWlzZSRfcHJveHlQcm9taXNlKHByb21pc2UpIHtcbiAgICBwcm9taXNlLl9zZXRQcm94aWVkKCk7XG4gICAgdGhpcy5fc2V0UHJveHlIYW5kbGVycyhwcm9taXNlLCAtMTUpO1xufTtcblxuUHJvbWlzZS5wcm90b3R5cGUuX3NldEJvdW5kVG8gPSBmdW5jdGlvbiBQcm9taXNlJF9zZXRCb3VuZFRvKG9iaikge1xuICAgIGlmIChvYmogIT09IHZvaWQgMCkge1xuICAgICAgICB0aGlzLl9iaXRGaWVsZCA9IHRoaXMuX2JpdEZpZWxkIHwgODM4ODYwODtcbiAgICAgICAgdGhpcy5fYm91bmRUbyA9IG9iajtcbiAgICB9IGVsc2Uge1xuICAgICAgICB0aGlzLl9iaXRGaWVsZCA9IHRoaXMuX2JpdEZpZWxkICYgKH44Mzg4NjA4KTtcbiAgICB9XG59O1xuXG5Qcm9taXNlLnByb3RvdHlwZS5faXNCb3VuZCA9IGZ1bmN0aW9uIFByb21pc2UkX2lzQm91bmQoKSB7XG4gICAgcmV0dXJuICh0aGlzLl9iaXRGaWVsZCAmIDgzODg2MDgpID09PSA4Mzg4NjA4O1xufTtcblxuUHJvbWlzZS5wcm90b3R5cGUuX3Jlc29sdmVGcm9tUmVzb2x2ZXIgPVxuZnVuY3Rpb24gUHJvbWlzZSRfcmVzb2x2ZUZyb21SZXNvbHZlcihyZXNvbHZlcikge1xuICAgIHZhciBwcm9taXNlID0gdGhpcztcbiAgICB0aGlzLl9zZXRUcmFjZSh2b2lkIDApO1xuICAgIHRoaXMuX3B1c2hDb250ZXh0KCk7XG5cbiAgICBmdW5jdGlvbiBQcm9taXNlJF9yZXNvbHZlcih2YWwpIHtcbiAgICAgICAgaWYgKHByb21pc2UuX3RyeUZvbGxvdyh2YWwpKSB7XG4gICAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cbiAgICAgICAgcHJvbWlzZS5fZnVsZmlsbCh2YWwpO1xuICAgIH1cbiAgICBmdW5jdGlvbiBQcm9taXNlJF9yZWplY3Rlcih2YWwpIHtcbiAgICAgICAgdmFyIHRyYWNlID0gY2FuQXR0YWNoKHZhbCkgPyB2YWwgOiBuZXcgRXJyb3IodmFsICsgXCJcIik7XG4gICAgICAgIHByb21pc2UuX2F0dGFjaEV4dHJhVHJhY2UodHJhY2UpO1xuICAgICAgICBtYXJrQXNPcmlnaW5hdGluZ0Zyb21SZWplY3Rpb24odmFsKTtcbiAgICAgICAgcHJvbWlzZS5fcmVqZWN0KHZhbCwgdHJhY2UgPT09IHZhbCA/IHZvaWQgMCA6IHRyYWNlKTtcbiAgICB9XG4gICAgdmFyIHIgPSB0cnlDYXRjaDIocmVzb2x2ZXIsIHZvaWQgMCwgUHJvbWlzZSRfcmVzb2x2ZXIsIFByb21pc2UkX3JlamVjdGVyKTtcbiAgICB0aGlzLl9wb3BDb250ZXh0KCk7XG5cbiAgICBpZiAociAhPT0gdm9pZCAwICYmIHIgPT09IGVycm9yT2JqKSB7XG4gICAgICAgIHZhciBlID0gci5lO1xuICAgICAgICB2YXIgdHJhY2UgPSBjYW5BdHRhY2goZSkgPyBlIDogbmV3IEVycm9yKGUgKyBcIlwiKTtcbiAgICAgICAgcHJvbWlzZS5fcmVqZWN0KGUsIHRyYWNlKTtcbiAgICB9XG59O1xuXG5Qcm9taXNlLnByb3RvdHlwZS5fc3ByZWFkU2xvd0Nhc2UgPVxuZnVuY3Rpb24gUHJvbWlzZSRfc3ByZWFkU2xvd0Nhc2UodGFyZ2V0Rm4sIHByb21pc2UsIHZhbHVlcywgYm91bmRUbykge1xuICAgIHZhciBwcm9taXNlRm9yQWxsID0gbmV3IFByb21pc2VBcnJheSh2YWx1ZXMpLnByb21pc2UoKTtcbiAgICB2YXIgcHJvbWlzZTIgPSBwcm9taXNlRm9yQWxsLl90aGVuKGZ1bmN0aW9uKCkge1xuICAgICAgICByZXR1cm4gdGFyZ2V0Rm4uYXBwbHkoYm91bmRUbywgYXJndW1lbnRzKTtcbiAgICB9LCB2b2lkIDAsIHZvaWQgMCwgQVBQTFksIHZvaWQgMCk7XG4gICAgcHJvbWlzZS5fZm9sbG93KHByb21pc2UyKTtcbn07XG5cblByb21pc2UucHJvdG90eXBlLl9jYWxsU3ByZWFkID1cbmZ1bmN0aW9uIFByb21pc2UkX2NhbGxTcHJlYWQoaGFuZGxlciwgcHJvbWlzZSwgdmFsdWUpIHtcbiAgICB2YXIgYm91bmRUbyA9IHRoaXMuX2JvdW5kVG87XG4gICAgaWYgKGlzQXJyYXkodmFsdWUpKSB7XG4gICAgICAgIGZvciAodmFyIGkgPSAwLCBsZW4gPSB2YWx1ZS5sZW5ndGg7IGkgPCBsZW47ICsraSkge1xuICAgICAgICAgICAgaWYgKGNhc3QodmFsdWVbaV0sIHZvaWQgMCkgaW5zdGFuY2VvZiBQcm9taXNlKSB7XG4gICAgICAgICAgICAgICAgdGhpcy5fc3ByZWFkU2xvd0Nhc2UoaGFuZGxlciwgcHJvbWlzZSwgdmFsdWUsIGJvdW5kVG8pO1xuICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgIH1cbiAgICBwcm9taXNlLl9wdXNoQ29udGV4dCgpO1xuICAgIHJldHVybiB0cnlDYXRjaEFwcGx5KGhhbmRsZXIsIHZhbHVlLCBib3VuZFRvKTtcbn07XG5cblByb21pc2UucHJvdG90eXBlLl9jYWxsSGFuZGxlciA9XG5mdW5jdGlvbiBQcm9taXNlJF9jYWxsSGFuZGxlcihcbiAgICBoYW5kbGVyLCByZWNlaXZlciwgcHJvbWlzZSwgdmFsdWUpIHtcbiAgICB2YXIgeDtcbiAgICBpZiAocmVjZWl2ZXIgPT09IEFQUExZICYmICF0aGlzLmlzUmVqZWN0ZWQoKSkge1xuICAgICAgICB4ID0gdGhpcy5fY2FsbFNwcmVhZChoYW5kbGVyLCBwcm9taXNlLCB2YWx1ZSk7XG4gICAgfSBlbHNlIHtcbiAgICAgICAgcHJvbWlzZS5fcHVzaENvbnRleHQoKTtcbiAgICAgICAgeCA9IHRyeUNhdGNoMShoYW5kbGVyLCByZWNlaXZlciwgdmFsdWUpO1xuICAgIH1cbiAgICBwcm9taXNlLl9wb3BDb250ZXh0KCk7XG4gICAgcmV0dXJuIHg7XG59O1xuXG5Qcm9taXNlLnByb3RvdHlwZS5fc2V0dGxlUHJvbWlzZUZyb21IYW5kbGVyID1cbmZ1bmN0aW9uIFByb21pc2UkX3NldHRsZVByb21pc2VGcm9tSGFuZGxlcihcbiAgICBoYW5kbGVyLCByZWNlaXZlciwgdmFsdWUsIHByb21pc2Vcbikge1xuICAgIGlmICghKHByb21pc2UgaW5zdGFuY2VvZiBQcm9taXNlKSkge1xuICAgICAgICBoYW5kbGVyLmNhbGwocmVjZWl2ZXIsIHZhbHVlLCBwcm9taXNlKTtcbiAgICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBpZiAocHJvbWlzZS5pc1Jlc29sdmVkKCkpIHJldHVybjtcbiAgICB2YXIgeCA9IHRoaXMuX2NhbGxIYW5kbGVyKGhhbmRsZXIsIHJlY2VpdmVyLCBwcm9taXNlLCB2YWx1ZSk7XG4gICAgaWYgKHByb21pc2UuX2lzRm9sbG93aW5nKCkpIHJldHVybjtcblxuICAgIGlmICh4ID09PSBlcnJvck9iaiB8fCB4ID09PSBwcm9taXNlIHx8IHggPT09IE5FWFRfRklMVEVSKSB7XG4gICAgICAgIHZhciBlcnIgPSB4ID09PSBwcm9taXNlXG4gICAgICAgICAgICAgICAgICAgID8gbWFrZVNlbGZSZXNvbHV0aW9uRXJyb3IoKVxuICAgICAgICAgICAgICAgICAgICA6IHguZTtcbiAgICAgICAgdmFyIHRyYWNlID0gY2FuQXR0YWNoKGVycikgPyBlcnIgOiBuZXcgRXJyb3IoZXJyICsgXCJcIik7XG4gICAgICAgIGlmICh4ICE9PSBORVhUX0ZJTFRFUikgcHJvbWlzZS5fYXR0YWNoRXh0cmFUcmFjZSh0cmFjZSk7XG4gICAgICAgIHByb21pc2UuX3JlamVjdFVuY2hlY2tlZChlcnIsIHRyYWNlKTtcbiAgICB9IGVsc2Uge1xuICAgICAgICB2YXIgY2FzdFZhbHVlID0gY2FzdCh4LCBwcm9taXNlKTtcbiAgICAgICAgaWYgKGNhc3RWYWx1ZSBpbnN0YW5jZW9mIFByb21pc2UpIHtcbiAgICAgICAgICAgIGlmIChjYXN0VmFsdWUuaXNSZWplY3RlZCgpICYmXG4gICAgICAgICAgICAgICAgIWNhc3RWYWx1ZS5faXNDYXJyeWluZ1N0YWNrVHJhY2UoKSAmJlxuICAgICAgICAgICAgICAgICFjYW5BdHRhY2goY2FzdFZhbHVlLl9zZXR0bGVkVmFsdWUpKSB7XG4gICAgICAgICAgICAgICAgdmFyIHRyYWNlID0gbmV3IEVycm9yKGNhc3RWYWx1ZS5fc2V0dGxlZFZhbHVlICsgXCJcIik7XG4gICAgICAgICAgICAgICAgcHJvbWlzZS5fYXR0YWNoRXh0cmFUcmFjZSh0cmFjZSk7XG4gICAgICAgICAgICAgICAgY2FzdFZhbHVlLl9zZXRDYXJyaWVkU3RhY2tUcmFjZSh0cmFjZSk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBwcm9taXNlLl9mb2xsb3coY2FzdFZhbHVlKTtcbiAgICAgICAgICAgIHByb21pc2UuX3Byb3BhZ2F0ZUZyb20oY2FzdFZhbHVlLCAxKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHByb21pc2UuX2Z1bGZpbGxVbmNoZWNrZWQoeCk7XG4gICAgICAgIH1cbiAgICB9XG59O1xuXG5Qcm9taXNlLnByb3RvdHlwZS5fZm9sbG93ID1cbmZ1bmN0aW9uIFByb21pc2UkX2ZvbGxvdyhwcm9taXNlKSB7XG4gICAgdGhpcy5fc2V0Rm9sbG93aW5nKCk7XG5cbiAgICBpZiAocHJvbWlzZS5pc1BlbmRpbmcoKSkge1xuICAgICAgICB0aGlzLl9wcm9wYWdhdGVGcm9tKHByb21pc2UsIDEpO1xuICAgICAgICBwcm9taXNlLl9wcm94eVByb21pc2UodGhpcyk7XG4gICAgfSBlbHNlIGlmIChwcm9taXNlLmlzRnVsZmlsbGVkKCkpIHtcbiAgICAgICAgdGhpcy5fZnVsZmlsbFVuY2hlY2tlZChwcm9taXNlLl9zZXR0bGVkVmFsdWUpO1xuICAgIH0gZWxzZSB7XG4gICAgICAgIHRoaXMuX3JlamVjdFVuY2hlY2tlZChwcm9taXNlLl9zZXR0bGVkVmFsdWUsXG4gICAgICAgICAgICBwcm9taXNlLl9nZXRDYXJyaWVkU3RhY2tUcmFjZSgpKTtcbiAgICB9XG5cbiAgICBpZiAocHJvbWlzZS5faXNSZWplY3Rpb25VbmhhbmRsZWQoKSkgcHJvbWlzZS5fdW5zZXRSZWplY3Rpb25Jc1VuaGFuZGxlZCgpO1xuXG4gICAgaWYgKGRlYnVnZ2luZyAmJlxuICAgICAgICBwcm9taXNlLl90cmFjZVBhcmVudCA9PSBudWxsKSB7XG4gICAgICAgIHByb21pc2UuX3RyYWNlUGFyZW50ID0gdGhpcztcbiAgICB9XG59O1xuXG5Qcm9taXNlLnByb3RvdHlwZS5fdHJ5Rm9sbG93ID1cbmZ1bmN0aW9uIFByb21pc2UkX3RyeUZvbGxvdyh2YWx1ZSkge1xuICAgIGlmICh0aGlzLl9pc0ZvbGxvd2luZ09yRnVsZmlsbGVkT3JSZWplY3RlZCgpIHx8XG4gICAgICAgIHZhbHVlID09PSB0aGlzKSB7XG4gICAgICAgIHJldHVybiBmYWxzZTtcbiAgICB9XG4gICAgdmFyIG1heWJlUHJvbWlzZSA9IGNhc3QodmFsdWUsIHZvaWQgMCk7XG4gICAgaWYgKCEobWF5YmVQcm9taXNlIGluc3RhbmNlb2YgUHJvbWlzZSkpIHtcbiAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgIH1cbiAgICB0aGlzLl9mb2xsb3cobWF5YmVQcm9taXNlKTtcbiAgICByZXR1cm4gdHJ1ZTtcbn07XG5cblByb21pc2UucHJvdG90eXBlLl9yZXNldFRyYWNlID0gZnVuY3Rpb24gUHJvbWlzZSRfcmVzZXRUcmFjZSgpIHtcbiAgICBpZiAoZGVidWdnaW5nKSB7XG4gICAgICAgIHRoaXMuX3RyYWNlID0gbmV3IENhcHR1cmVkVHJhY2UodGhpcy5fcGVla0NvbnRleHQoKSA9PT0gdm9pZCAwKTtcbiAgICB9XG59O1xuXG5Qcm9taXNlLnByb3RvdHlwZS5fc2V0VHJhY2UgPSBmdW5jdGlvbiBQcm9taXNlJF9zZXRUcmFjZShwYXJlbnQpIHtcbiAgICBpZiAoZGVidWdnaW5nKSB7XG4gICAgICAgIHZhciBjb250ZXh0ID0gdGhpcy5fcGVla0NvbnRleHQoKTtcbiAgICAgICAgdGhpcy5fdHJhY2VQYXJlbnQgPSBjb250ZXh0O1xuICAgICAgICB2YXIgaXNUb3BMZXZlbCA9IGNvbnRleHQgPT09IHZvaWQgMDtcbiAgICAgICAgaWYgKHBhcmVudCAhPT0gdm9pZCAwICYmXG4gICAgICAgICAgICBwYXJlbnQuX3RyYWNlUGFyZW50ID09PSBjb250ZXh0KSB7XG4gICAgICAgICAgICB0aGlzLl90cmFjZSA9IHBhcmVudC5fdHJhY2U7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICB0aGlzLl90cmFjZSA9IG5ldyBDYXB0dXJlZFRyYWNlKGlzVG9wTGV2ZWwpO1xuICAgICAgICB9XG4gICAgfVxuICAgIHJldHVybiB0aGlzO1xufTtcblxuUHJvbWlzZS5wcm90b3R5cGUuX3RyeUF0dGFjaEV4dHJhVHJhY2UgPVxuZnVuY3Rpb24gUHJvbWlzZSRfdHJ5QXR0YWNoRXh0cmFUcmFjZShlcnJvcikge1xuICAgIGlmIChjYW5BdHRhY2goZXJyb3IpKSB7XG4gICAgICAgIHRoaXMuX2F0dGFjaEV4dHJhVHJhY2UoZXJyb3IpO1xuICAgIH1cbn07XG5cblByb21pc2UucHJvdG90eXBlLl9hdHRhY2hFeHRyYVRyYWNlID1cbmZ1bmN0aW9uIFByb21pc2UkX2F0dGFjaEV4dHJhVHJhY2UoZXJyb3IpIHtcbiAgICBpZiAoZGVidWdnaW5nKSB7XG4gICAgICAgIHZhciBwcm9taXNlID0gdGhpcztcbiAgICAgICAgdmFyIHN0YWNrID0gZXJyb3Iuc3RhY2s7XG4gICAgICAgIHN0YWNrID0gdHlwZW9mIHN0YWNrID09PSBcInN0cmluZ1wiID8gc3RhY2suc3BsaXQoXCJcXG5cIikgOiBbXTtcbiAgICAgICAgQ2FwdHVyZWRUcmFjZS5wcm90ZWN0RXJyb3JNZXNzYWdlTmV3bGluZXMoc3RhY2spO1xuICAgICAgICB2YXIgaGVhZGVyTGluZUNvdW50ID0gMTtcbiAgICAgICAgdmFyIGNvbWJpbmVkVHJhY2VzID0gMTtcbiAgICAgICAgd2hpbGUocHJvbWlzZSAhPSBudWxsICYmXG4gICAgICAgICAgICBwcm9taXNlLl90cmFjZSAhPSBudWxsKSB7XG4gICAgICAgICAgICBzdGFjayA9IENhcHR1cmVkVHJhY2UuY29tYmluZShcbiAgICAgICAgICAgICAgICBzdGFjayxcbiAgICAgICAgICAgICAgICBwcm9taXNlLl90cmFjZS5zdGFjay5zcGxpdChcIlxcblwiKVxuICAgICAgICAgICAgKTtcbiAgICAgICAgICAgIHByb21pc2UgPSBwcm9taXNlLl90cmFjZVBhcmVudDtcbiAgICAgICAgICAgIGNvbWJpbmVkVHJhY2VzKys7XG4gICAgICAgIH1cblxuICAgICAgICB2YXIgc3RhY2tUcmFjZUxpbWl0ID0gRXJyb3Iuc3RhY2tUcmFjZUxpbWl0IHx8IDEwO1xuICAgICAgICB2YXIgbWF4ID0gKHN0YWNrVHJhY2VMaW1pdCArIGhlYWRlckxpbmVDb3VudCkgKiBjb21iaW5lZFRyYWNlcztcbiAgICAgICAgdmFyIGxlbiA9IHN0YWNrLmxlbmd0aDtcbiAgICAgICAgaWYgKGxlbiA+IG1heCkge1xuICAgICAgICAgICAgc3RhY2subGVuZ3RoID0gbWF4O1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKGxlbiA+IDApXG4gICAgICAgICAgICBzdGFja1swXSA9IHN0YWNrWzBdLnNwbGl0KFwiXFx1MDAwMlxcdTAwMDBcXHUwMDAxXCIpLmpvaW4oXCJcXG5cIik7XG5cbiAgICAgICAgaWYgKHN0YWNrLmxlbmd0aCA8PSBoZWFkZXJMaW5lQ291bnQpIHtcbiAgICAgICAgICAgIGVycm9yLnN0YWNrID0gXCIoTm8gc3RhY2sgdHJhY2UpXCI7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBlcnJvci5zdGFjayA9IHN0YWNrLmpvaW4oXCJcXG5cIik7XG4gICAgICAgIH1cbiAgICB9XG59O1xuXG5Qcm9taXNlLnByb3RvdHlwZS5fY2xlYW5WYWx1ZXMgPSBmdW5jdGlvbiBQcm9taXNlJF9jbGVhblZhbHVlcygpIHtcbiAgICBpZiAodGhpcy5fY2FuY2VsbGFibGUoKSkge1xuICAgICAgICB0aGlzLl9jYW5jZWxsYXRpb25QYXJlbnQgPSB2b2lkIDA7XG4gICAgfVxufTtcblxuUHJvbWlzZS5wcm90b3R5cGUuX3Byb3BhZ2F0ZUZyb20gPVxuZnVuY3Rpb24gUHJvbWlzZSRfcHJvcGFnYXRlRnJvbShwYXJlbnQsIGZsYWdzKSB7XG4gICAgaWYgKChmbGFncyAmIDEpID4gMCAmJiBwYXJlbnQuX2NhbmNlbGxhYmxlKCkpIHtcbiAgICAgICAgdGhpcy5fc2V0Q2FuY2VsbGFibGUoKTtcbiAgICAgICAgdGhpcy5fY2FuY2VsbGF0aW9uUGFyZW50ID0gcGFyZW50O1xuICAgIH1cbiAgICBpZiAoKGZsYWdzICYgNCkgPiAwKSB7XG4gICAgICAgIHRoaXMuX3NldEJvdW5kVG8ocGFyZW50Ll9ib3VuZFRvKTtcbiAgICB9XG4gICAgaWYgKChmbGFncyAmIDIpID4gMCkge1xuICAgICAgICB0aGlzLl9zZXRUcmFjZShwYXJlbnQpO1xuICAgIH1cbn07XG5cblByb21pc2UucHJvdG90eXBlLl9mdWxmaWxsID0gZnVuY3Rpb24gUHJvbWlzZSRfZnVsZmlsbCh2YWx1ZSkge1xuICAgIGlmICh0aGlzLl9pc0ZvbGxvd2luZ09yRnVsZmlsbGVkT3JSZWplY3RlZCgpKSByZXR1cm47XG4gICAgdGhpcy5fZnVsZmlsbFVuY2hlY2tlZCh2YWx1ZSk7XG59O1xuXG5Qcm9taXNlLnByb3RvdHlwZS5fcmVqZWN0ID1cbmZ1bmN0aW9uIFByb21pc2UkX3JlamVjdChyZWFzb24sIGNhcnJpZWRTdGFja1RyYWNlKSB7XG4gICAgaWYgKHRoaXMuX2lzRm9sbG93aW5nT3JGdWxmaWxsZWRPclJlamVjdGVkKCkpIHJldHVybjtcbiAgICB0aGlzLl9yZWplY3RVbmNoZWNrZWQocmVhc29uLCBjYXJyaWVkU3RhY2tUcmFjZSk7XG59O1xuXG5Qcm9taXNlLnByb3RvdHlwZS5fc2V0dGxlUHJvbWlzZUF0ID0gZnVuY3Rpb24gUHJvbWlzZSRfc2V0dGxlUHJvbWlzZUF0KGluZGV4KSB7XG4gICAgdmFyIGhhbmRsZXIgPSB0aGlzLmlzRnVsZmlsbGVkKClcbiAgICAgICAgPyB0aGlzLl9mdWxmaWxsbWVudEhhbmRsZXJBdChpbmRleClcbiAgICAgICAgOiB0aGlzLl9yZWplY3Rpb25IYW5kbGVyQXQoaW5kZXgpO1xuXG4gICAgdmFyIHZhbHVlID0gdGhpcy5fc2V0dGxlZFZhbHVlO1xuICAgIHZhciByZWNlaXZlciA9IHRoaXMuX3JlY2VpdmVyQXQoaW5kZXgpO1xuICAgIHZhciBwcm9taXNlID0gdGhpcy5fcHJvbWlzZUF0KGluZGV4KTtcblxuICAgIGlmICh0eXBlb2YgaGFuZGxlciA9PT0gXCJmdW5jdGlvblwiKSB7XG4gICAgICAgIHRoaXMuX3NldHRsZVByb21pc2VGcm9tSGFuZGxlcihoYW5kbGVyLCByZWNlaXZlciwgdmFsdWUsIHByb21pc2UpO1xuICAgIH0gZWxzZSB7XG4gICAgICAgIHZhciBkb25lID0gZmFsc2U7XG4gICAgICAgIHZhciBpc0Z1bGZpbGxlZCA9IHRoaXMuaXNGdWxmaWxsZWQoKTtcbiAgICAgICAgaWYgKHJlY2VpdmVyICE9PSB2b2lkIDApIHtcbiAgICAgICAgICAgIGlmIChyZWNlaXZlciBpbnN0YW5jZW9mIFByb21pc2UgJiZcbiAgICAgICAgICAgICAgICByZWNlaXZlci5faXNQcm94aWVkKCkpIHtcbiAgICAgICAgICAgICAgICByZWNlaXZlci5fdW5zZXRQcm94aWVkKCk7XG5cbiAgICAgICAgICAgICAgICBpZiAoaXNGdWxmaWxsZWQpIHJlY2VpdmVyLl9mdWxmaWxsVW5jaGVja2VkKHZhbHVlKTtcbiAgICAgICAgICAgICAgICBlbHNlIHJlY2VpdmVyLl9yZWplY3RVbmNoZWNrZWQodmFsdWUsXG4gICAgICAgICAgICAgICAgICAgIHRoaXMuX2dldENhcnJpZWRTdGFja1RyYWNlKCkpO1xuICAgICAgICAgICAgICAgIGRvbmUgPSB0cnVlO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChyZWNlaXZlciBpbnN0YW5jZW9mIFByb21pc2VBcnJheSkge1xuICAgICAgICAgICAgICAgIGlmIChpc0Z1bGZpbGxlZCkgcmVjZWl2ZXIuX3Byb21pc2VGdWxmaWxsZWQodmFsdWUsIHByb21pc2UpO1xuICAgICAgICAgICAgICAgIGVsc2UgcmVjZWl2ZXIuX3Byb21pc2VSZWplY3RlZCh2YWx1ZSwgcHJvbWlzZSk7XG4gICAgICAgICAgICAgICAgZG9uZSA9IHRydWU7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoIWRvbmUpIHtcbiAgICAgICAgICAgIGlmIChpc0Z1bGZpbGxlZCkgcHJvbWlzZS5fZnVsZmlsbCh2YWx1ZSk7XG4gICAgICAgICAgICBlbHNlIHByb21pc2UuX3JlamVjdCh2YWx1ZSwgdGhpcy5fZ2V0Q2FycmllZFN0YWNrVHJhY2UoKSk7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICBpZiAoaW5kZXggPj0gNCkge1xuICAgICAgICB0aGlzLl9xdWV1ZUdDKCk7XG4gICAgfVxufTtcblxuUHJvbWlzZS5wcm90b3R5cGUuX2lzUHJveGllZCA9IGZ1bmN0aW9uIFByb21pc2UkX2lzUHJveGllZCgpIHtcbiAgICByZXR1cm4gKHRoaXMuX2JpdEZpZWxkICYgNDE5NDMwNCkgPT09IDQxOTQzMDQ7XG59O1xuXG5Qcm9taXNlLnByb3RvdHlwZS5fc2V0UHJveGllZCA9IGZ1bmN0aW9uIFByb21pc2UkX3NldFByb3hpZWQoKSB7XG4gICAgdGhpcy5fYml0RmllbGQgPSB0aGlzLl9iaXRGaWVsZCB8IDQxOTQzMDQ7XG59O1xuXG5Qcm9taXNlLnByb3RvdHlwZS5fdW5zZXRQcm94aWVkID0gZnVuY3Rpb24gUHJvbWlzZSRfdW5zZXRQcm94aWVkKCkge1xuICAgIHRoaXMuX2JpdEZpZWxkID0gdGhpcy5fYml0RmllbGQgJiAofjQxOTQzMDQpO1xufTtcblxuUHJvbWlzZS5wcm90b3R5cGUuX2lzR2NRdWV1ZWQgPSBmdW5jdGlvbiBQcm9taXNlJF9pc0djUXVldWVkKCkge1xuICAgIHJldHVybiAodGhpcy5fYml0RmllbGQgJiAtMTA3Mzc0MTgyNCkgPT09IC0xMDczNzQxODI0O1xufTtcblxuUHJvbWlzZS5wcm90b3R5cGUuX3NldEdjUXVldWVkID0gZnVuY3Rpb24gUHJvbWlzZSRfc2V0R2NRdWV1ZWQoKSB7XG4gICAgdGhpcy5fYml0RmllbGQgPSB0aGlzLl9iaXRGaWVsZCB8IC0xMDczNzQxODI0O1xufTtcblxuUHJvbWlzZS5wcm90b3R5cGUuX3Vuc2V0R2NRdWV1ZWQgPSBmdW5jdGlvbiBQcm9taXNlJF91bnNldEdjUXVldWVkKCkge1xuICAgIHRoaXMuX2JpdEZpZWxkID0gdGhpcy5fYml0RmllbGQgJiAofi0xMDczNzQxODI0KTtcbn07XG5cblByb21pc2UucHJvdG90eXBlLl9xdWV1ZUdDID0gZnVuY3Rpb24gUHJvbWlzZSRfcXVldWVHQygpIHtcbiAgICBpZiAodGhpcy5faXNHY1F1ZXVlZCgpKSByZXR1cm47XG4gICAgdGhpcy5fc2V0R2NRdWV1ZWQoKTtcbiAgICBhc3luYy5pbnZva2VMYXRlcih0aGlzLl9nYywgdGhpcywgdm9pZCAwKTtcbn07XG5cblByb21pc2UucHJvdG90eXBlLl9nYyA9IGZ1bmN0aW9uIFByb21pc2UkZ2MoKSB7XG4gICAgdmFyIGxlbiA9IHRoaXMuX2xlbmd0aCgpICogNSAtIDU7XG4gICAgZm9yICh2YXIgaSA9IDA7IGkgPCBsZW47IGkrKykge1xuICAgICAgICBkZWxldGUgdGhpc1tpXTtcbiAgICB9XG4gICAgdGhpcy5fY2xlYXJGaXJzdEhhbmRsZXJEYXRhKCk7XG4gICAgdGhpcy5fc2V0TGVuZ3RoKDApO1xuICAgIHRoaXMuX3Vuc2V0R2NRdWV1ZWQoKTtcbn07XG5cblByb21pc2UucHJvdG90eXBlLl9jbGVhckZpcnN0SGFuZGxlckRhdGEgPVxuZnVuY3Rpb24gUHJvbWlzZSRfY2xlYXJGaXJzdEhhbmRsZXJEYXRhKCkge1xuICAgIHRoaXMuX2Z1bGZpbGxtZW50SGFuZGxlcjAgPSB2b2lkIDA7XG4gICAgdGhpcy5fcmVqZWN0aW9uSGFuZGxlcjAgPSB2b2lkIDA7XG4gICAgdGhpcy5fcHJvbWlzZTAgPSB2b2lkIDA7XG4gICAgdGhpcy5fcmVjZWl2ZXIwID0gdm9pZCAwO1xufTtcblxuUHJvbWlzZS5wcm90b3R5cGUuX3F1ZXVlU2V0dGxlQXQgPSBmdW5jdGlvbiBQcm9taXNlJF9xdWV1ZVNldHRsZUF0KGluZGV4KSB7XG4gICAgaWYgKHRoaXMuX2lzUmVqZWN0aW9uVW5oYW5kbGVkKCkpIHRoaXMuX3Vuc2V0UmVqZWN0aW9uSXNVbmhhbmRsZWQoKTtcbiAgICBhc3luYy5pbnZva2UodGhpcy5fc2V0dGxlUHJvbWlzZUF0LCB0aGlzLCBpbmRleCk7XG59O1xuXG5Qcm9taXNlLnByb3RvdHlwZS5fZnVsZmlsbFVuY2hlY2tlZCA9XG5mdW5jdGlvbiBQcm9taXNlJF9mdWxmaWxsVW5jaGVja2VkKHZhbHVlKSB7XG4gICAgaWYgKCF0aGlzLmlzUGVuZGluZygpKSByZXR1cm47XG4gICAgaWYgKHZhbHVlID09PSB0aGlzKSB7XG4gICAgICAgIHZhciBlcnIgPSBtYWtlU2VsZlJlc29sdXRpb25FcnJvcigpO1xuICAgICAgICB0aGlzLl9hdHRhY2hFeHRyYVRyYWNlKGVycik7XG4gICAgICAgIHJldHVybiB0aGlzLl9yZWplY3RVbmNoZWNrZWQoZXJyLCB2b2lkIDApO1xuICAgIH1cbiAgICB0aGlzLl9jbGVhblZhbHVlcygpO1xuICAgIHRoaXMuX3NldEZ1bGZpbGxlZCgpO1xuICAgIHRoaXMuX3NldHRsZWRWYWx1ZSA9IHZhbHVlO1xuICAgIHZhciBsZW4gPSB0aGlzLl9sZW5ndGgoKTtcblxuICAgIGlmIChsZW4gPiAwKSB7XG4gICAgICAgIGFzeW5jLmludm9rZSh0aGlzLl9zZXR0bGVQcm9taXNlcywgdGhpcywgbGVuKTtcbiAgICB9XG59O1xuXG5Qcm9taXNlLnByb3RvdHlwZS5fcmVqZWN0VW5jaGVja2VkQ2hlY2tFcnJvciA9XG5mdW5jdGlvbiBQcm9taXNlJF9yZWplY3RVbmNoZWNrZWRDaGVja0Vycm9yKHJlYXNvbikge1xuICAgIHZhciB0cmFjZSA9IGNhbkF0dGFjaChyZWFzb24pID8gcmVhc29uIDogbmV3IEVycm9yKHJlYXNvbiArIFwiXCIpO1xuICAgIHRoaXMuX3JlamVjdFVuY2hlY2tlZChyZWFzb24sIHRyYWNlID09PSByZWFzb24gPyB2b2lkIDAgOiB0cmFjZSk7XG59O1xuXG5Qcm9taXNlLnByb3RvdHlwZS5fcmVqZWN0VW5jaGVja2VkID1cbmZ1bmN0aW9uIFByb21pc2UkX3JlamVjdFVuY2hlY2tlZChyZWFzb24sIHRyYWNlKSB7XG4gICAgaWYgKCF0aGlzLmlzUGVuZGluZygpKSByZXR1cm47XG4gICAgaWYgKHJlYXNvbiA9PT0gdGhpcykge1xuICAgICAgICB2YXIgZXJyID0gbWFrZVNlbGZSZXNvbHV0aW9uRXJyb3IoKTtcbiAgICAgICAgdGhpcy5fYXR0YWNoRXh0cmFUcmFjZShlcnIpO1xuICAgICAgICByZXR1cm4gdGhpcy5fcmVqZWN0VW5jaGVja2VkKGVycik7XG4gICAgfVxuICAgIHRoaXMuX2NsZWFuVmFsdWVzKCk7XG4gICAgdGhpcy5fc2V0UmVqZWN0ZWQoKTtcbiAgICB0aGlzLl9zZXR0bGVkVmFsdWUgPSByZWFzb247XG5cbiAgICBpZiAodGhpcy5faXNGaW5hbCgpKSB7XG4gICAgICAgIGFzeW5jLmludm9rZUxhdGVyKHRocm93ZXIsIHZvaWQgMCwgdHJhY2UgPT09IHZvaWQgMCA/IHJlYXNvbiA6IHRyYWNlKTtcbiAgICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICB2YXIgbGVuID0gdGhpcy5fbGVuZ3RoKCk7XG5cbiAgICBpZiAodHJhY2UgIT09IHZvaWQgMCkgdGhpcy5fc2V0Q2FycmllZFN0YWNrVHJhY2UodHJhY2UpO1xuXG4gICAgaWYgKGxlbiA+IDApIHtcbiAgICAgICAgYXN5bmMuaW52b2tlKHRoaXMuX3JlamVjdFByb21pc2VzLCB0aGlzLCBudWxsKTtcbiAgICB9IGVsc2Uge1xuICAgICAgICB0aGlzLl9lbnN1cmVQb3NzaWJsZVJlamVjdGlvbkhhbmRsZWQoKTtcbiAgICB9XG59O1xuXG5Qcm9taXNlLnByb3RvdHlwZS5fcmVqZWN0UHJvbWlzZXMgPSBmdW5jdGlvbiBQcm9taXNlJF9yZWplY3RQcm9taXNlcygpIHtcbiAgICB0aGlzLl9zZXR0bGVQcm9taXNlcygpO1xuICAgIHRoaXMuX3Vuc2V0Q2FycmllZFN0YWNrVHJhY2UoKTtcbn07XG5cblByb21pc2UucHJvdG90eXBlLl9zZXR0bGVQcm9taXNlcyA9IGZ1bmN0aW9uIFByb21pc2UkX3NldHRsZVByb21pc2VzKCkge1xuICAgIHZhciBsZW4gPSB0aGlzLl9sZW5ndGgoKTtcbiAgICBmb3IgKHZhciBpID0gMDsgaSA8IGxlbjsgaSsrKSB7XG4gICAgICAgIHRoaXMuX3NldHRsZVByb21pc2VBdChpKTtcbiAgICB9XG59O1xuXG5Qcm9taXNlLnByb3RvdHlwZS5fZW5zdXJlUG9zc2libGVSZWplY3Rpb25IYW5kbGVkID1cbmZ1bmN0aW9uIFByb21pc2UkX2Vuc3VyZVBvc3NpYmxlUmVqZWN0aW9uSGFuZGxlZCgpIHtcbiAgICB0aGlzLl9zZXRSZWplY3Rpb25Jc1VuaGFuZGxlZCgpO1xuICAgIGlmIChDYXB0dXJlZFRyYWNlLnBvc3NpYmx5VW5oYW5kbGVkUmVqZWN0aW9uICE9PSB2b2lkIDApIHtcbiAgICAgICAgYXN5bmMuaW52b2tlTGF0ZXIodGhpcy5fbm90aWZ5VW5oYW5kbGVkUmVqZWN0aW9uLCB0aGlzLCB2b2lkIDApO1xuICAgIH1cbn07XG5cblByb21pc2UucHJvdG90eXBlLl9ub3RpZnlVbmhhbmRsZWRSZWplY3Rpb25Jc0hhbmRsZWQgPVxuZnVuY3Rpb24gUHJvbWlzZSRfbm90aWZ5VW5oYW5kbGVkUmVqZWN0aW9uSXNIYW5kbGVkKCkge1xuICAgIGlmICh0eXBlb2YgdW5oYW5kbGVkUmVqZWN0aW9uSGFuZGxlZCA9PT0gXCJmdW5jdGlvblwiKSB7XG4gICAgICAgIGFzeW5jLmludm9rZUxhdGVyKHVuaGFuZGxlZFJlamVjdGlvbkhhbmRsZWQsIHZvaWQgMCwgdGhpcyk7XG4gICAgfVxufTtcblxuUHJvbWlzZS5wcm90b3R5cGUuX25vdGlmeVVuaGFuZGxlZFJlamVjdGlvbiA9XG5mdW5jdGlvbiBQcm9taXNlJF9ub3RpZnlVbmhhbmRsZWRSZWplY3Rpb24oKSB7XG4gICAgaWYgKHRoaXMuX2lzUmVqZWN0aW9uVW5oYW5kbGVkKCkpIHtcbiAgICAgICAgdmFyIHJlYXNvbiA9IHRoaXMuX3NldHRsZWRWYWx1ZTtcbiAgICAgICAgdmFyIHRyYWNlID0gdGhpcy5fZ2V0Q2FycmllZFN0YWNrVHJhY2UoKTtcblxuICAgICAgICB0aGlzLl9zZXRVbmhhbmRsZWRSZWplY3Rpb25Jc05vdGlmaWVkKCk7XG5cbiAgICAgICAgaWYgKHRyYWNlICE9PSB2b2lkIDApIHtcbiAgICAgICAgICAgIHRoaXMuX3Vuc2V0Q2FycmllZFN0YWNrVHJhY2UoKTtcbiAgICAgICAgICAgIHJlYXNvbiA9IHRyYWNlO1xuICAgICAgICB9XG4gICAgICAgIGlmICh0eXBlb2YgQ2FwdHVyZWRUcmFjZS5wb3NzaWJseVVuaGFuZGxlZFJlamVjdGlvbiA9PT0gXCJmdW5jdGlvblwiKSB7XG4gICAgICAgICAgICBDYXB0dXJlZFRyYWNlLnBvc3NpYmx5VW5oYW5kbGVkUmVqZWN0aW9uKHJlYXNvbiwgdGhpcyk7XG4gICAgICAgIH1cbiAgICB9XG59O1xuXG52YXIgY29udGV4dFN0YWNrID0gW107XG5Qcm9taXNlLnByb3RvdHlwZS5fcGVla0NvbnRleHQgPSBmdW5jdGlvbiBQcm9taXNlJF9wZWVrQ29udGV4dCgpIHtcbiAgICB2YXIgbGFzdEluZGV4ID0gY29udGV4dFN0YWNrLmxlbmd0aCAtIDE7XG4gICAgaWYgKGxhc3RJbmRleCA+PSAwKSB7XG4gICAgICAgIHJldHVybiBjb250ZXh0U3RhY2tbbGFzdEluZGV4XTtcbiAgICB9XG4gICAgcmV0dXJuIHZvaWQgMDtcblxufTtcblxuUHJvbWlzZS5wcm90b3R5cGUuX3B1c2hDb250ZXh0ID0gZnVuY3Rpb24gUHJvbWlzZSRfcHVzaENvbnRleHQoKSB7XG4gICAgaWYgKCFkZWJ1Z2dpbmcpIHJldHVybjtcbiAgICBjb250ZXh0U3RhY2sucHVzaCh0aGlzKTtcbn07XG5cblByb21pc2UucHJvdG90eXBlLl9wb3BDb250ZXh0ID0gZnVuY3Rpb24gUHJvbWlzZSRfcG9wQ29udGV4dCgpIHtcbiAgICBpZiAoIWRlYnVnZ2luZykgcmV0dXJuO1xuICAgIGNvbnRleHRTdGFjay5wb3AoKTtcbn07XG5cblByb21pc2Uubm9Db25mbGljdCA9IGZ1bmN0aW9uIFByb21pc2UkTm9Db25mbGljdCgpIHtcbiAgICByZXR1cm4gbm9Db25mbGljdChQcm9taXNlKTtcbn07XG5cblByb21pc2Uuc2V0U2NoZWR1bGVyID0gZnVuY3Rpb24oZm4pIHtcbiAgICBpZiAodHlwZW9mIGZuICE9PSBcImZ1bmN0aW9uXCIpIHRocm93IG5ldyBUeXBlRXJyb3IoXCJmbiBtdXN0IGJlIGEgZnVuY3Rpb25cIik7XG4gICAgYXN5bmMuX3NjaGVkdWxlID0gZm47XG59O1xuXG5pZiAoIUNhcHR1cmVkVHJhY2UuaXNTdXBwb3J0ZWQoKSkge1xuICAgIFByb21pc2UubG9uZ1N0YWNrVHJhY2VzID0gZnVuY3Rpb24oKXt9O1xuICAgIGRlYnVnZ2luZyA9IGZhbHNlO1xufVxuXG5Qcm9taXNlLl9tYWtlU2VsZlJlc29sdXRpb25FcnJvciA9IG1ha2VTZWxmUmVzb2x1dGlvbkVycm9yO1xucmVxdWlyZShcIi4vZmluYWxseS5qc1wiKShQcm9taXNlLCBORVhUX0ZJTFRFUiwgY2FzdCk7XG5yZXF1aXJlKFwiLi9kaXJlY3RfcmVzb2x2ZS5qc1wiKShQcm9taXNlKTtcbnJlcXVpcmUoXCIuL3N5bmNocm9ub3VzX2luc3BlY3Rpb24uanNcIikoUHJvbWlzZSk7XG5yZXF1aXJlKFwiLi9qb2luLmpzXCIpKFByb21pc2UsIFByb21pc2VBcnJheSwgY2FzdCwgSU5URVJOQUwpO1xuUHJvbWlzZS5SYW5nZUVycm9yID0gUmFuZ2VFcnJvcjtcblByb21pc2UuQ2FuY2VsbGF0aW9uRXJyb3IgPSBDYW5jZWxsYXRpb25FcnJvcjtcblByb21pc2UuVGltZW91dEVycm9yID0gVGltZW91dEVycm9yO1xuUHJvbWlzZS5UeXBlRXJyb3IgPSBUeXBlRXJyb3I7XG5Qcm9taXNlLk9wZXJhdGlvbmFsRXJyb3IgPSBPcGVyYXRpb25hbEVycm9yO1xuUHJvbWlzZS5SZWplY3Rpb25FcnJvciA9IE9wZXJhdGlvbmFsRXJyb3I7XG5Qcm9taXNlLkFnZ3JlZ2F0ZUVycm9yID0gZXJyb3JzLkFnZ3JlZ2F0ZUVycm9yO1xuXG51dGlsLnRvRmFzdFByb3BlcnRpZXMoUHJvbWlzZSk7XG51dGlsLnRvRmFzdFByb3BlcnRpZXMoUHJvbWlzZS5wcm90b3R5cGUpO1xuUHJvbWlzZS5Qcm9taXNlID0gUHJvbWlzZTtcbnJlcXVpcmUoJy4vdGltZXJzLmpzJykoUHJvbWlzZSxJTlRFUk5BTCxjYXN0KTtcbnJlcXVpcmUoJy4vcmFjZS5qcycpKFByb21pc2UsSU5URVJOQUwsY2FzdCk7XG5yZXF1aXJlKCcuL2NhbGxfZ2V0LmpzJykoUHJvbWlzZSk7XG5yZXF1aXJlKCcuL2dlbmVyYXRvcnMuanMnKShQcm9taXNlLGFwaVJlamVjdGlvbixJTlRFUk5BTCxjYXN0KTtcbnJlcXVpcmUoJy4vbWFwLmpzJykoUHJvbWlzZSxQcm9taXNlQXJyYXksYXBpUmVqZWN0aW9uLGNhc3QsSU5URVJOQUwpO1xucmVxdWlyZSgnLi9ub2RlaWZ5LmpzJykoUHJvbWlzZSk7XG5yZXF1aXJlKCcuL3Byb21pc2lmeS5qcycpKFByb21pc2UsSU5URVJOQUwpO1xucmVxdWlyZSgnLi9wcm9wcy5qcycpKFByb21pc2UsUHJvbWlzZUFycmF5LGNhc3QpO1xucmVxdWlyZSgnLi9yZWR1Y2UuanMnKShQcm9taXNlLFByb21pc2VBcnJheSxhcGlSZWplY3Rpb24sY2FzdCxJTlRFUk5BTCk7XG5yZXF1aXJlKCcuL3NldHRsZS5qcycpKFByb21pc2UsUHJvbWlzZUFycmF5KTtcbnJlcXVpcmUoJy4vc29tZS5qcycpKFByb21pc2UsUHJvbWlzZUFycmF5LGFwaVJlamVjdGlvbik7XG5yZXF1aXJlKCcuL3Byb2dyZXNzLmpzJykoUHJvbWlzZSxQcm9taXNlQXJyYXkpO1xucmVxdWlyZSgnLi9jYW5jZWwuanMnKShQcm9taXNlLElOVEVSTkFMKTtcbnJlcXVpcmUoJy4vZmlsdGVyLmpzJykoUHJvbWlzZSxJTlRFUk5BTCk7XG5yZXF1aXJlKCcuL2FueS5qcycpKFByb21pc2UsUHJvbWlzZUFycmF5KTtcbnJlcXVpcmUoJy4vZWFjaC5qcycpKFByb21pc2UsSU5URVJOQUwpO1xucmVxdWlyZSgnLi91c2luZy5qcycpKFByb21pc2UsYXBpUmVqZWN0aW9uLGNhc3QpO1xuXG5Qcm9taXNlLnByb3RvdHlwZSA9IFByb21pc2UucHJvdG90eXBlO1xucmV0dXJuIFByb21pc2U7XG5cbn07XG4iLCIvKipcbiAqIFRoZSBNSVQgTGljZW5zZSAoTUlUKVxuICogXG4gKiBDb3B5cmlnaHQgKGMpIDIwMTQgUGV0a2EgQW50b25vdlxuICogXG4gKiBQZXJtaXNzaW9uIGlzIGhlcmVieSBncmFudGVkLCBmcmVlIG9mIGNoYXJnZSwgdG8gYW55IHBlcnNvbiBvYnRhaW5pbmcgYSBjb3B5XG4gKiBvZiB0aGlzIHNvZnR3YXJlIGFuZCBhc3NvY2lhdGVkIGRvY3VtZW50YXRpb24gZmlsZXMgKHRoZSBcIlNvZnR3YXJlXCIpLCB0byBkZWFsXG4gKiBpbiB0aGUgU29mdHdhcmUgd2l0aG91dCByZXN0cmljdGlvbiwgaW5jbHVkaW5nIHdpdGhvdXQgbGltaXRhdGlvbiB0aGUgcmlnaHRzXG4gKiB0byB1c2UsIGNvcHksIG1vZGlmeSwgbWVyZ2UsIHB1Ymxpc2gsIGRpc3RyaWJ1dGUsIHN1YmxpY2Vuc2UsIGFuZC9vciBzZWxsXG4gKiBjb3BpZXMgb2YgdGhlIFNvZnR3YXJlLCBhbmQgdG8gcGVybWl0IHBlcnNvbnMgdG8gd2hvbSB0aGUgU29mdHdhcmUgaXNcbiAqIGZ1cm5pc2hlZCB0byBkbyBzbywgc3ViamVjdCB0byB0aGUgZm9sbG93aW5nIGNvbmRpdGlvbnM6PC9wPlxuICogXG4gKiBUaGUgYWJvdmUgY29weXJpZ2h0IG5vdGljZSBhbmQgdGhpcyBwZXJtaXNzaW9uIG5vdGljZSBzaGFsbCBiZSBpbmNsdWRlZCBpblxuICogYWxsIGNvcGllcyBvciBzdWJzdGFudGlhbCBwb3J0aW9ucyBvZiB0aGUgU29mdHdhcmUuXG4gKiBcbiAqIFRIRSBTT0ZUV0FSRSBJUyBQUk9WSURFRCBcIkFTIElTXCIsIFdJVEhPVVQgV0FSUkFOVFkgT0YgQU5ZIEtJTkQsIEVYUFJFU1MgT1JcbiAqIElNUExJRUQsIElOQ0xVRElORyBCVVQgTk9UIExJTUlURUQgVE8gVEhFIFdBUlJBTlRJRVMgT0YgTUVSQ0hBTlRBQklMSVRZLFxuICogRklUTkVTUyBGT1IgQSBQQVJUSUNVTEFSIFBVUlBPU0UgQU5EIE5PTklORlJJTkdFTUVOVC4gIElOIE5PIEVWRU5UIFNIQUxMIFRIRVxuICogQVVUSE9SUyBPUiBDT1BZUklHSFQgSE9MREVSUyBCRSBMSUFCTEUgRk9SIEFOWSBDTEFJTSwgREFNQUdFUyBPUiBPVEhFUlxuICogTElBQklMSVRZLCBXSEVUSEVSIElOIEFOIEFDVElPTiBPRiBDT05UUkFDVCwgVE9SVCBPUiBPVEhFUldJU0UsIEFSSVNJTkcgRlJPTSxcbiAqIE9VVCBPRiBPUiBJTiBDT05ORUNUSU9OIFdJVEggVEhFIFNPRlRXQVJFIE9SIFRIRSBVU0UgT1IgT1RIRVIgREVBTElOR1MgSU5cbiAqIFRIRSBTT0ZUV0FSRS5cbiAqIFxuICovXG5cInVzZSBzdHJpY3RcIjtcbm1vZHVsZS5leHBvcnRzID0gZnVuY3Rpb24oUHJvbWlzZSwgSU5URVJOQUwsIGNhc3QpIHtcbnZhciBjYW5BdHRhY2ggPSByZXF1aXJlKFwiLi9lcnJvcnMuanNcIikuY2FuQXR0YWNoO1xudmFyIHV0aWwgPSByZXF1aXJlKFwiLi91dGlsLmpzXCIpO1xudmFyIGlzQXJyYXkgPSB1dGlsLmlzQXJyYXk7XG5cbmZ1bmN0aW9uIHRvUmVzb2x1dGlvblZhbHVlKHZhbCkge1xuICAgIHN3aXRjaCh2YWwpIHtcbiAgICBjYXNlIC0xOiByZXR1cm4gdm9pZCAwO1xuICAgIGNhc2UgLTI6IHJldHVybiBbXTtcbiAgICBjYXNlIC0zOiByZXR1cm4ge307XG4gICAgfVxufVxuXG5mdW5jdGlvbiBQcm9taXNlQXJyYXkodmFsdWVzKSB7XG4gICAgdmFyIHByb21pc2UgPSB0aGlzLl9wcm9taXNlID0gbmV3IFByb21pc2UoSU5URVJOQUwpO1xuICAgIHZhciBwYXJlbnQgPSB2b2lkIDA7XG4gICAgaWYgKHZhbHVlcyBpbnN0YW5jZW9mIFByb21pc2UpIHtcbiAgICAgICAgcGFyZW50ID0gdmFsdWVzO1xuICAgICAgICBwcm9taXNlLl9wcm9wYWdhdGVGcm9tKHBhcmVudCwgMSB8IDQpO1xuICAgIH1cbiAgICBwcm9taXNlLl9zZXRUcmFjZShwYXJlbnQpO1xuICAgIHRoaXMuX3ZhbHVlcyA9IHZhbHVlcztcbiAgICB0aGlzLl9sZW5ndGggPSAwO1xuICAgIHRoaXMuX3RvdGFsUmVzb2x2ZWQgPSAwO1xuICAgIHRoaXMuX2luaXQodm9pZCAwLCAtMik7XG59XG5Qcm9taXNlQXJyYXkucHJvdG90eXBlLmxlbmd0aCA9IGZ1bmN0aW9uIFByb21pc2VBcnJheSRsZW5ndGgoKSB7XG4gICAgcmV0dXJuIHRoaXMuX2xlbmd0aDtcbn07XG5cblByb21pc2VBcnJheS5wcm90b3R5cGUucHJvbWlzZSA9IGZ1bmN0aW9uIFByb21pc2VBcnJheSRwcm9taXNlKCkge1xuICAgIHJldHVybiB0aGlzLl9wcm9taXNlO1xufTtcblxuUHJvbWlzZUFycmF5LnByb3RvdHlwZS5faW5pdCA9XG5mdW5jdGlvbiBQcm9taXNlQXJyYXkkX2luaXQoXywgcmVzb2x2ZVZhbHVlSWZFbXB0eSkge1xuICAgIHZhciB2YWx1ZXMgPSBjYXN0KHRoaXMuX3ZhbHVlcywgdm9pZCAwKTtcbiAgICBpZiAodmFsdWVzIGluc3RhbmNlb2YgUHJvbWlzZSkge1xuICAgICAgICB0aGlzLl92YWx1ZXMgPSB2YWx1ZXM7XG4gICAgICAgIHZhbHVlcy5fc2V0Qm91bmRUbyh0aGlzLl9wcm9taXNlLl9ib3VuZFRvKTtcbiAgICAgICAgaWYgKHZhbHVlcy5pc0Z1bGZpbGxlZCgpKSB7XG4gICAgICAgICAgICB2YWx1ZXMgPSB2YWx1ZXMuX3NldHRsZWRWYWx1ZTtcbiAgICAgICAgICAgIGlmICghaXNBcnJheSh2YWx1ZXMpKSB7XG4gICAgICAgICAgICAgICAgdmFyIGVyciA9IG5ldyBQcm9taXNlLlR5cGVFcnJvcihcImV4cGVjdGluZyBhbiBhcnJheSwgYSBwcm9taXNlIG9yIGEgdGhlbmFibGVcIik7XG4gICAgICAgICAgICAgICAgdGhpcy5fX2hhcmRSZWplY3RfXyhlcnIpO1xuICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSBlbHNlIGlmICh2YWx1ZXMuaXNQZW5kaW5nKCkpIHtcbiAgICAgICAgICAgIHZhbHVlcy5fdGhlbihcbiAgICAgICAgICAgICAgICBQcm9taXNlQXJyYXkkX2luaXQsXG4gICAgICAgICAgICAgICAgdGhpcy5fcmVqZWN0LFxuICAgICAgICAgICAgICAgIHZvaWQgMCxcbiAgICAgICAgICAgICAgICB0aGlzLFxuICAgICAgICAgICAgICAgIHJlc29sdmVWYWx1ZUlmRW1wdHlcbiAgICAgICAgICAgKTtcbiAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHZhbHVlcy5fdW5zZXRSZWplY3Rpb25Jc1VuaGFuZGxlZCgpO1xuICAgICAgICAgICAgdGhpcy5fcmVqZWN0KHZhbHVlcy5fc2V0dGxlZFZhbHVlKTtcbiAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuICAgIH0gZWxzZSBpZiAoIWlzQXJyYXkodmFsdWVzKSkge1xuICAgICAgICB2YXIgZXJyID0gbmV3IFByb21pc2UuVHlwZUVycm9yKFwiZXhwZWN0aW5nIGFuIGFycmF5LCBhIHByb21pc2Ugb3IgYSB0aGVuYWJsZVwiKTtcbiAgICAgICAgdGhpcy5fX2hhcmRSZWplY3RfXyhlcnIpO1xuICAgICAgICByZXR1cm47XG4gICAgfVxuXG4gICAgaWYgKHZhbHVlcy5sZW5ndGggPT09IDApIHtcbiAgICAgICAgaWYgKHJlc29sdmVWYWx1ZUlmRW1wdHkgPT09IC01KSB7XG4gICAgICAgICAgICB0aGlzLl9yZXNvbHZlRW1wdHlBcnJheSgpO1xuICAgICAgICB9XG4gICAgICAgIGVsc2Uge1xuICAgICAgICAgICAgdGhpcy5fcmVzb2x2ZSh0b1Jlc29sdXRpb25WYWx1ZShyZXNvbHZlVmFsdWVJZkVtcHR5KSk7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICB2YXIgbGVuID0gdGhpcy5nZXRBY3R1YWxMZW5ndGgodmFsdWVzLmxlbmd0aCk7XG4gICAgdmFyIG5ld0xlbiA9IGxlbjtcbiAgICB2YXIgbmV3VmFsdWVzID0gdGhpcy5zaG91bGRDb3B5VmFsdWVzKCkgPyBuZXcgQXJyYXkobGVuKSA6IHRoaXMuX3ZhbHVlcztcbiAgICB2YXIgaXNEaXJlY3RTY2FuTmVlZGVkID0gZmFsc2U7XG4gICAgZm9yICh2YXIgaSA9IDA7IGkgPCBsZW47ICsraSkge1xuICAgICAgICB2YXIgbWF5YmVQcm9taXNlID0gY2FzdCh2YWx1ZXNbaV0sIHZvaWQgMCk7XG4gICAgICAgIGlmIChtYXliZVByb21pc2UgaW5zdGFuY2VvZiBQcm9taXNlKSB7XG4gICAgICAgICAgICBpZiAobWF5YmVQcm9taXNlLmlzUGVuZGluZygpKSB7XG4gICAgICAgICAgICAgICAgbWF5YmVQcm9taXNlLl9wcm94eVByb21pc2VBcnJheSh0aGlzLCBpKTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgbWF5YmVQcm9taXNlLl91bnNldFJlamVjdGlvbklzVW5oYW5kbGVkKCk7XG4gICAgICAgICAgICAgICAgaXNEaXJlY3RTY2FuTmVlZGVkID0gdHJ1ZTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIGlzRGlyZWN0U2Nhbk5lZWRlZCA9IHRydWU7XG4gICAgICAgIH1cbiAgICAgICAgbmV3VmFsdWVzW2ldID0gbWF5YmVQcm9taXNlO1xuICAgIH1cbiAgICB0aGlzLl92YWx1ZXMgPSBuZXdWYWx1ZXM7XG4gICAgdGhpcy5fbGVuZ3RoID0gbmV3TGVuO1xuICAgIGlmIChpc0RpcmVjdFNjYW5OZWVkZWQpIHtcbiAgICAgICAgdGhpcy5fc2NhbkRpcmVjdFZhbHVlcyhsZW4pO1xuICAgIH1cbn07XG5cblByb21pc2VBcnJheS5wcm90b3R5cGUuX3NldHRsZVByb21pc2VBdCA9XG5mdW5jdGlvbiBQcm9taXNlQXJyYXkkX3NldHRsZVByb21pc2VBdChpbmRleCkge1xuICAgIHZhciB2YWx1ZSA9IHRoaXMuX3ZhbHVlc1tpbmRleF07XG4gICAgaWYgKCEodmFsdWUgaW5zdGFuY2VvZiBQcm9taXNlKSkge1xuICAgICAgICB0aGlzLl9wcm9taXNlRnVsZmlsbGVkKHZhbHVlLCBpbmRleCk7XG4gICAgfSBlbHNlIGlmICh2YWx1ZS5pc0Z1bGZpbGxlZCgpKSB7XG4gICAgICAgIHRoaXMuX3Byb21pc2VGdWxmaWxsZWQodmFsdWUuX3NldHRsZWRWYWx1ZSwgaW5kZXgpO1xuICAgIH0gZWxzZSBpZiAodmFsdWUuaXNSZWplY3RlZCgpKSB7XG4gICAgICAgIHRoaXMuX3Byb21pc2VSZWplY3RlZCh2YWx1ZS5fc2V0dGxlZFZhbHVlLCBpbmRleCk7XG4gICAgfVxufTtcblxuUHJvbWlzZUFycmF5LnByb3RvdHlwZS5fc2NhbkRpcmVjdFZhbHVlcyA9XG5mdW5jdGlvbiBQcm9taXNlQXJyYXkkX3NjYW5EaXJlY3RWYWx1ZXMobGVuKSB7XG4gICAgZm9yICh2YXIgaSA9IDA7IGkgPCBsZW47ICsraSkge1xuICAgICAgICBpZiAodGhpcy5faXNSZXNvbHZlZCgpKSB7XG4gICAgICAgICAgICBicmVhaztcbiAgICAgICAgfVxuICAgICAgICB0aGlzLl9zZXR0bGVQcm9taXNlQXQoaSk7XG4gICAgfVxufTtcblxuUHJvbWlzZUFycmF5LnByb3RvdHlwZS5faXNSZXNvbHZlZCA9IGZ1bmN0aW9uIFByb21pc2VBcnJheSRfaXNSZXNvbHZlZCgpIHtcbiAgICByZXR1cm4gdGhpcy5fdmFsdWVzID09PSBudWxsO1xufTtcblxuUHJvbWlzZUFycmF5LnByb3RvdHlwZS5fcmVzb2x2ZSA9IGZ1bmN0aW9uIFByb21pc2VBcnJheSRfcmVzb2x2ZSh2YWx1ZSkge1xuICAgIHRoaXMuX3ZhbHVlcyA9IG51bGw7XG4gICAgdGhpcy5fcHJvbWlzZS5fZnVsZmlsbCh2YWx1ZSk7XG59O1xuXG5Qcm9taXNlQXJyYXkucHJvdG90eXBlLl9faGFyZFJlamVjdF9fID1cblByb21pc2VBcnJheS5wcm90b3R5cGUuX3JlamVjdCA9IGZ1bmN0aW9uIFByb21pc2VBcnJheSRfcmVqZWN0KHJlYXNvbikge1xuICAgIHRoaXMuX3ZhbHVlcyA9IG51bGw7XG4gICAgdmFyIHRyYWNlID0gY2FuQXR0YWNoKHJlYXNvbikgPyByZWFzb24gOiBuZXcgRXJyb3IocmVhc29uICsgXCJcIik7XG4gICAgdGhpcy5fcHJvbWlzZS5fYXR0YWNoRXh0cmFUcmFjZSh0cmFjZSk7XG4gICAgdGhpcy5fcHJvbWlzZS5fcmVqZWN0KHJlYXNvbiwgdHJhY2UpO1xufTtcblxuUHJvbWlzZUFycmF5LnByb3RvdHlwZS5fcHJvbWlzZVByb2dyZXNzZWQgPVxuZnVuY3Rpb24gUHJvbWlzZUFycmF5JF9wcm9taXNlUHJvZ3Jlc3NlZChwcm9ncmVzc1ZhbHVlLCBpbmRleCkge1xuICAgIGlmICh0aGlzLl9pc1Jlc29sdmVkKCkpIHJldHVybjtcbiAgICB0aGlzLl9wcm9taXNlLl9wcm9ncmVzcyh7XG4gICAgICAgIGluZGV4OiBpbmRleCxcbiAgICAgICAgdmFsdWU6IHByb2dyZXNzVmFsdWVcbiAgICB9KTtcbn07XG5cblxuUHJvbWlzZUFycmF5LnByb3RvdHlwZS5fcHJvbWlzZUZ1bGZpbGxlZCA9XG5mdW5jdGlvbiBQcm9taXNlQXJyYXkkX3Byb21pc2VGdWxmaWxsZWQodmFsdWUsIGluZGV4KSB7XG4gICAgaWYgKHRoaXMuX2lzUmVzb2x2ZWQoKSkgcmV0dXJuO1xuICAgIHRoaXMuX3ZhbHVlc1tpbmRleF0gPSB2YWx1ZTtcbiAgICB2YXIgdG90YWxSZXNvbHZlZCA9ICsrdGhpcy5fdG90YWxSZXNvbHZlZDtcbiAgICBpZiAodG90YWxSZXNvbHZlZCA+PSB0aGlzLl9sZW5ndGgpIHtcbiAgICAgICAgdGhpcy5fcmVzb2x2ZSh0aGlzLl92YWx1ZXMpO1xuICAgIH1cbn07XG5cblByb21pc2VBcnJheS5wcm90b3R5cGUuX3Byb21pc2VSZWplY3RlZCA9XG5mdW5jdGlvbiBQcm9taXNlQXJyYXkkX3Byb21pc2VSZWplY3RlZChyZWFzb24sIGluZGV4KSB7XG4gICAgaWYgKHRoaXMuX2lzUmVzb2x2ZWQoKSkgcmV0dXJuO1xuICAgIHRoaXMuX3RvdGFsUmVzb2x2ZWQrKztcbiAgICB0aGlzLl9yZWplY3QocmVhc29uKTtcbn07XG5cblByb21pc2VBcnJheS5wcm90b3R5cGUuc2hvdWxkQ29weVZhbHVlcyA9XG5mdW5jdGlvbiBQcm9taXNlQXJyYXkkX3Nob3VsZENvcHlWYWx1ZXMoKSB7XG4gICAgcmV0dXJuIHRydWU7XG59O1xuXG5Qcm9taXNlQXJyYXkucHJvdG90eXBlLmdldEFjdHVhbExlbmd0aCA9XG5mdW5jdGlvbiBQcm9taXNlQXJyYXkkZ2V0QWN0dWFsTGVuZ3RoKGxlbikge1xuICAgIHJldHVybiBsZW47XG59O1xuXG5yZXR1cm4gUHJvbWlzZUFycmF5O1xufTtcbiIsIi8qKlxuICogVGhlIE1JVCBMaWNlbnNlIChNSVQpXG4gKiBcbiAqIENvcHlyaWdodCAoYykgMjAxNCBQZXRrYSBBbnRvbm92XG4gKiBcbiAqIFBlcm1pc3Npb24gaXMgaGVyZWJ5IGdyYW50ZWQsIGZyZWUgb2YgY2hhcmdlLCB0byBhbnkgcGVyc29uIG9idGFpbmluZyBhIGNvcHlcbiAqIG9mIHRoaXMgc29mdHdhcmUgYW5kIGFzc29jaWF0ZWQgZG9jdW1lbnRhdGlvbiBmaWxlcyAodGhlIFwiU29mdHdhcmVcIiksIHRvIGRlYWxcbiAqIGluIHRoZSBTb2Z0d2FyZSB3aXRob3V0IHJlc3RyaWN0aW9uLCBpbmNsdWRpbmcgd2l0aG91dCBsaW1pdGF0aW9uIHRoZSByaWdodHNcbiAqIHRvIHVzZSwgY29weSwgbW9kaWZ5LCBtZXJnZSwgcHVibGlzaCwgZGlzdHJpYnV0ZSwgc3VibGljZW5zZSwgYW5kL29yIHNlbGxcbiAqIGNvcGllcyBvZiB0aGUgU29mdHdhcmUsIGFuZCB0byBwZXJtaXQgcGVyc29ucyB0byB3aG9tIHRoZSBTb2Z0d2FyZSBpc1xuICogZnVybmlzaGVkIHRvIGRvIHNvLCBzdWJqZWN0IHRvIHRoZSBmb2xsb3dpbmcgY29uZGl0aW9uczo8L3A+XG4gKiBcbiAqIFRoZSBhYm92ZSBjb3B5cmlnaHQgbm90aWNlIGFuZCB0aGlzIHBlcm1pc3Npb24gbm90aWNlIHNoYWxsIGJlIGluY2x1ZGVkIGluXG4gKiBhbGwgY29waWVzIG9yIHN1YnN0YW50aWFsIHBvcnRpb25zIG9mIHRoZSBTb2Z0d2FyZS5cbiAqIFxuICogVEhFIFNPRlRXQVJFIElTIFBST1ZJREVEIFwiQVMgSVNcIiwgV0lUSE9VVCBXQVJSQU5UWSBPRiBBTlkgS0lORCwgRVhQUkVTUyBPUlxuICogSU1QTElFRCwgSU5DTFVESU5HIEJVVCBOT1QgTElNSVRFRCBUTyBUSEUgV0FSUkFOVElFUyBPRiBNRVJDSEFOVEFCSUxJVFksXG4gKiBGSVRORVNTIEZPUiBBIFBBUlRJQ1VMQVIgUFVSUE9TRSBBTkQgTk9OSU5GUklOR0VNRU5ULiAgSU4gTk8gRVZFTlQgU0hBTEwgVEhFXG4gKiBBVVRIT1JTIE9SIENPUFlSSUdIVCBIT0xERVJTIEJFIExJQUJMRSBGT1IgQU5ZIENMQUlNLCBEQU1BR0VTIE9SIE9USEVSXG4gKiBMSUFCSUxJVFksIFdIRVRIRVIgSU4gQU4gQUNUSU9OIE9GIENPTlRSQUNULCBUT1JUIE9SIE9USEVSV0lTRSwgQVJJU0lORyBGUk9NLFxuICogT1VUIE9GIE9SIElOIENPTk5FQ1RJT04gV0lUSCBUSEUgU09GVFdBUkUgT1IgVEhFIFVTRSBPUiBPVEhFUiBERUFMSU5HUyBJTlxuICogVEhFIFNPRlRXQVJFLlxuICogXG4gKi9cblwidXNlIHN0cmljdFwiO1xudmFyIHV0aWwgPSByZXF1aXJlKFwiLi91dGlsLmpzXCIpO1xudmFyIG1heWJlV3JhcEFzRXJyb3IgPSB1dGlsLm1heWJlV3JhcEFzRXJyb3I7XG52YXIgZXJyb3JzID0gcmVxdWlyZShcIi4vZXJyb3JzLmpzXCIpO1xudmFyIFRpbWVvdXRFcnJvciA9IGVycm9ycy5UaW1lb3V0RXJyb3I7XG52YXIgT3BlcmF0aW9uYWxFcnJvciA9IGVycm9ycy5PcGVyYXRpb25hbEVycm9yO1xudmFyIGFzeW5jID0gcmVxdWlyZShcIi4vYXN5bmMuanNcIik7XG52YXIgaGF2ZUdldHRlcnMgPSB1dGlsLmhhdmVHZXR0ZXJzO1xudmFyIGVzNSA9IHJlcXVpcmUoXCIuL2VzNS5qc1wiKTtcblxuZnVuY3Rpb24gaXNVbnR5cGVkRXJyb3Iob2JqKSB7XG4gICAgcmV0dXJuIG9iaiBpbnN0YW5jZW9mIEVycm9yICYmXG4gICAgICAgIGVzNS5nZXRQcm90b3R5cGVPZihvYmopID09PSBFcnJvci5wcm90b3R5cGU7XG59XG5cbmZ1bmN0aW9uIHdyYXBBc09wZXJhdGlvbmFsRXJyb3Iob2JqKSB7XG4gICAgdmFyIHJldDtcbiAgICBpZiAoaXNVbnR5cGVkRXJyb3Iob2JqKSkge1xuICAgICAgICByZXQgPSBuZXcgT3BlcmF0aW9uYWxFcnJvcihvYmopO1xuICAgIH0gZWxzZSB7XG4gICAgICAgIHJldCA9IG9iajtcbiAgICB9XG4gICAgZXJyb3JzLm1hcmtBc09yaWdpbmF0aW5nRnJvbVJlamVjdGlvbihyZXQpO1xuICAgIHJldHVybiByZXQ7XG59XG5cbmZ1bmN0aW9uIG5vZGViYWNrRm9yUHJvbWlzZShwcm9taXNlKSB7XG4gICAgZnVuY3Rpb24gUHJvbWlzZVJlc29sdmVyJF9jYWxsYmFjayhlcnIsIHZhbHVlKSB7XG4gICAgICAgIGlmIChwcm9taXNlID09PSBudWxsKSByZXR1cm47XG5cbiAgICAgICAgaWYgKGVycikge1xuICAgICAgICAgICAgdmFyIHdyYXBwZWQgPSB3cmFwQXNPcGVyYXRpb25hbEVycm9yKG1heWJlV3JhcEFzRXJyb3IoZXJyKSk7XG4gICAgICAgICAgICBwcm9taXNlLl9hdHRhY2hFeHRyYVRyYWNlKHdyYXBwZWQpO1xuICAgICAgICAgICAgcHJvbWlzZS5fcmVqZWN0KHdyYXBwZWQpO1xuICAgICAgICB9IGVsc2UgaWYgKGFyZ3VtZW50cy5sZW5ndGggPiAyKSB7XG4gICAgICAgICAgICB2YXIgJF9sZW4gPSBhcmd1bWVudHMubGVuZ3RoO3ZhciBhcmdzID0gbmV3IEFycmF5KCRfbGVuIC0gMSk7IGZvcih2YXIgJF9pID0gMTsgJF9pIDwgJF9sZW47ICsrJF9pKSB7YXJnc1skX2kgLSAxXSA9IGFyZ3VtZW50c1skX2ldO31cbiAgICAgICAgICAgIHByb21pc2UuX2Z1bGZpbGwoYXJncyk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBwcm9taXNlLl9mdWxmaWxsKHZhbHVlKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHByb21pc2UgPSBudWxsO1xuICAgIH1cbiAgICByZXR1cm4gUHJvbWlzZVJlc29sdmVyJF9jYWxsYmFjaztcbn1cblxuXG52YXIgUHJvbWlzZVJlc29sdmVyO1xuaWYgKCFoYXZlR2V0dGVycykge1xuICAgIFByb21pc2VSZXNvbHZlciA9IGZ1bmN0aW9uIFByb21pc2VSZXNvbHZlcihwcm9taXNlKSB7XG4gICAgICAgIHRoaXMucHJvbWlzZSA9IHByb21pc2U7XG4gICAgICAgIHRoaXMuYXNDYWxsYmFjayA9IG5vZGViYWNrRm9yUHJvbWlzZShwcm9taXNlKTtcbiAgICAgICAgdGhpcy5jYWxsYmFjayA9IHRoaXMuYXNDYWxsYmFjaztcbiAgICB9O1xufVxuZWxzZSB7XG4gICAgUHJvbWlzZVJlc29sdmVyID0gZnVuY3Rpb24gUHJvbWlzZVJlc29sdmVyKHByb21pc2UpIHtcbiAgICAgICAgdGhpcy5wcm9taXNlID0gcHJvbWlzZTtcbiAgICB9O1xufVxuaWYgKGhhdmVHZXR0ZXJzKSB7XG4gICAgdmFyIHByb3AgPSB7XG4gICAgICAgIGdldDogZnVuY3Rpb24oKSB7XG4gICAgICAgICAgICByZXR1cm4gbm9kZWJhY2tGb3JQcm9taXNlKHRoaXMucHJvbWlzZSk7XG4gICAgICAgIH1cbiAgICB9O1xuICAgIGVzNS5kZWZpbmVQcm9wZXJ0eShQcm9taXNlUmVzb2x2ZXIucHJvdG90eXBlLCBcImFzQ2FsbGJhY2tcIiwgcHJvcCk7XG4gICAgZXM1LmRlZmluZVByb3BlcnR5KFByb21pc2VSZXNvbHZlci5wcm90b3R5cGUsIFwiY2FsbGJhY2tcIiwgcHJvcCk7XG59XG5cblByb21pc2VSZXNvbHZlci5fbm9kZWJhY2tGb3JQcm9taXNlID0gbm9kZWJhY2tGb3JQcm9taXNlO1xuXG5Qcm9taXNlUmVzb2x2ZXIucHJvdG90eXBlLnRvU3RyaW5nID0gZnVuY3Rpb24gUHJvbWlzZVJlc29sdmVyJHRvU3RyaW5nKCkge1xuICAgIHJldHVybiBcIltvYmplY3QgUHJvbWlzZVJlc29sdmVyXVwiO1xufTtcblxuUHJvbWlzZVJlc29sdmVyLnByb3RvdHlwZS5yZXNvbHZlID1cblByb21pc2VSZXNvbHZlci5wcm90b3R5cGUuZnVsZmlsbCA9IGZ1bmN0aW9uIFByb21pc2VSZXNvbHZlciRyZXNvbHZlKHZhbHVlKSB7XG4gICAgaWYgKCEodGhpcyBpbnN0YW5jZW9mIFByb21pc2VSZXNvbHZlcikpIHtcbiAgICAgICAgdGhyb3cgbmV3IFR5cGVFcnJvcihcIklsbGVnYWwgaW52b2NhdGlvbiwgcmVzb2x2ZXIgcmVzb2x2ZS9yZWplY3QgbXVzdCBiZSBjYWxsZWQgd2l0aGluIGEgcmVzb2x2ZXIgY29udGV4dC4gQ29uc2lkZXIgdXNpbmcgdGhlIHByb21pc2UgY29uc3RydWN0b3IgaW5zdGVhZC5cIik7XG4gICAgfVxuXG4gICAgdmFyIHByb21pc2UgPSB0aGlzLnByb21pc2U7XG4gICAgaWYgKHByb21pc2UuX3RyeUZvbGxvdyh2YWx1ZSkpIHtcbiAgICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBhc3luYy5pbnZva2UocHJvbWlzZS5fZnVsZmlsbCwgcHJvbWlzZSwgdmFsdWUpO1xufTtcblxuUHJvbWlzZVJlc29sdmVyLnByb3RvdHlwZS5yZWplY3QgPSBmdW5jdGlvbiBQcm9taXNlUmVzb2x2ZXIkcmVqZWN0KHJlYXNvbikge1xuICAgIGlmICghKHRoaXMgaW5zdGFuY2VvZiBQcm9taXNlUmVzb2x2ZXIpKSB7XG4gICAgICAgIHRocm93IG5ldyBUeXBlRXJyb3IoXCJJbGxlZ2FsIGludm9jYXRpb24sIHJlc29sdmVyIHJlc29sdmUvcmVqZWN0IG11c3QgYmUgY2FsbGVkIHdpdGhpbiBhIHJlc29sdmVyIGNvbnRleHQuIENvbnNpZGVyIHVzaW5nIHRoZSBwcm9taXNlIGNvbnN0cnVjdG9yIGluc3RlYWQuXCIpO1xuICAgIH1cblxuICAgIHZhciBwcm9taXNlID0gdGhpcy5wcm9taXNlO1xuICAgIGVycm9ycy5tYXJrQXNPcmlnaW5hdGluZ0Zyb21SZWplY3Rpb24ocmVhc29uKTtcbiAgICB2YXIgdHJhY2UgPSBlcnJvcnMuY2FuQXR0YWNoKHJlYXNvbikgPyByZWFzb24gOiBuZXcgRXJyb3IocmVhc29uICsgXCJcIik7XG4gICAgcHJvbWlzZS5fYXR0YWNoRXh0cmFUcmFjZSh0cmFjZSk7XG4gICAgYXN5bmMuaW52b2tlKHByb21pc2UuX3JlamVjdCwgcHJvbWlzZSwgcmVhc29uKTtcbiAgICBpZiAodHJhY2UgIT09IHJlYXNvbikge1xuICAgICAgICBhc3luYy5pbnZva2UodGhpcy5fc2V0Q2FycmllZFN0YWNrVHJhY2UsIHRoaXMsIHRyYWNlKTtcbiAgICB9XG59O1xuXG5Qcm9taXNlUmVzb2x2ZXIucHJvdG90eXBlLnByb2dyZXNzID1cbmZ1bmN0aW9uIFByb21pc2VSZXNvbHZlciRwcm9ncmVzcyh2YWx1ZSkge1xuICAgIGlmICghKHRoaXMgaW5zdGFuY2VvZiBQcm9taXNlUmVzb2x2ZXIpKSB7XG4gICAgICAgIHRocm93IG5ldyBUeXBlRXJyb3IoXCJJbGxlZ2FsIGludm9jYXRpb24sIHJlc29sdmVyIHJlc29sdmUvcmVqZWN0IG11c3QgYmUgY2FsbGVkIHdpdGhpbiBhIHJlc29sdmVyIGNvbnRleHQuIENvbnNpZGVyIHVzaW5nIHRoZSBwcm9taXNlIGNvbnN0cnVjdG9yIGluc3RlYWQuXCIpO1xuICAgIH1cbiAgICBhc3luYy5pbnZva2UodGhpcy5wcm9taXNlLl9wcm9ncmVzcywgdGhpcy5wcm9taXNlLCB2YWx1ZSk7XG59O1xuXG5Qcm9taXNlUmVzb2x2ZXIucHJvdG90eXBlLmNhbmNlbCA9IGZ1bmN0aW9uIFByb21pc2VSZXNvbHZlciRjYW5jZWwoKSB7XG4gICAgYXN5bmMuaW52b2tlKHRoaXMucHJvbWlzZS5jYW5jZWwsIHRoaXMucHJvbWlzZSwgdm9pZCAwKTtcbn07XG5cblByb21pc2VSZXNvbHZlci5wcm90b3R5cGUudGltZW91dCA9IGZ1bmN0aW9uIFByb21pc2VSZXNvbHZlciR0aW1lb3V0KCkge1xuICAgIHRoaXMucmVqZWN0KG5ldyBUaW1lb3V0RXJyb3IoXCJ0aW1lb3V0XCIpKTtcbn07XG5cblByb21pc2VSZXNvbHZlci5wcm90b3R5cGUuaXNSZXNvbHZlZCA9IGZ1bmN0aW9uIFByb21pc2VSZXNvbHZlciRpc1Jlc29sdmVkKCkge1xuICAgIHJldHVybiB0aGlzLnByb21pc2UuaXNSZXNvbHZlZCgpO1xufTtcblxuUHJvbWlzZVJlc29sdmVyLnByb3RvdHlwZS50b0pTT04gPSBmdW5jdGlvbiBQcm9taXNlUmVzb2x2ZXIkdG9KU09OKCkge1xuICAgIHJldHVybiB0aGlzLnByb21pc2UudG9KU09OKCk7XG59O1xuXG5Qcm9taXNlUmVzb2x2ZXIucHJvdG90eXBlLl9zZXRDYXJyaWVkU3RhY2tUcmFjZSA9XG5mdW5jdGlvbiBQcm9taXNlUmVzb2x2ZXIkX3NldENhcnJpZWRTdGFja1RyYWNlKHRyYWNlKSB7XG4gICAgaWYgKHRoaXMucHJvbWlzZS5pc1JlamVjdGVkKCkpIHtcbiAgICAgICAgdGhpcy5wcm9taXNlLl9zZXRDYXJyaWVkU3RhY2tUcmFjZSh0cmFjZSk7XG4gICAgfVxufTtcblxubW9kdWxlLmV4cG9ydHMgPSBQcm9taXNlUmVzb2x2ZXI7XG4iLCIvKipcbiAqIFRoZSBNSVQgTGljZW5zZSAoTUlUKVxuICogXG4gKiBDb3B5cmlnaHQgKGMpIDIwMTQgUGV0a2EgQW50b25vdlxuICogXG4gKiBQZXJtaXNzaW9uIGlzIGhlcmVieSBncmFudGVkLCBmcmVlIG9mIGNoYXJnZSwgdG8gYW55IHBlcnNvbiBvYnRhaW5pbmcgYSBjb3B5XG4gKiBvZiB0aGlzIHNvZnR3YXJlIGFuZCBhc3NvY2lhdGVkIGRvY3VtZW50YXRpb24gZmlsZXMgKHRoZSBcIlNvZnR3YXJlXCIpLCB0byBkZWFsXG4gKiBpbiB0aGUgU29mdHdhcmUgd2l0aG91dCByZXN0cmljdGlvbiwgaW5jbHVkaW5nIHdpdGhvdXQgbGltaXRhdGlvbiB0aGUgcmlnaHRzXG4gKiB0byB1c2UsIGNvcHksIG1vZGlmeSwgbWVyZ2UsIHB1Ymxpc2gsIGRpc3RyaWJ1dGUsIHN1YmxpY2Vuc2UsIGFuZC9vciBzZWxsXG4gKiBjb3BpZXMgb2YgdGhlIFNvZnR3YXJlLCBhbmQgdG8gcGVybWl0IHBlcnNvbnMgdG8gd2hvbSB0aGUgU29mdHdhcmUgaXNcbiAqIGZ1cm5pc2hlZCB0byBkbyBzbywgc3ViamVjdCB0byB0aGUgZm9sbG93aW5nIGNvbmRpdGlvbnM6PC9wPlxuICogXG4gKiBUaGUgYWJvdmUgY29weXJpZ2h0IG5vdGljZSBhbmQgdGhpcyBwZXJtaXNzaW9uIG5vdGljZSBzaGFsbCBiZSBpbmNsdWRlZCBpblxuICogYWxsIGNvcGllcyBvciBzdWJzdGFudGlhbCBwb3J0aW9ucyBvZiB0aGUgU29mdHdhcmUuXG4gKiBcbiAqIFRIRSBTT0ZUV0FSRSBJUyBQUk9WSURFRCBcIkFTIElTXCIsIFdJVEhPVVQgV0FSUkFOVFkgT0YgQU5ZIEtJTkQsIEVYUFJFU1MgT1JcbiAqIElNUExJRUQsIElOQ0xVRElORyBCVVQgTk9UIExJTUlURUQgVE8gVEhFIFdBUlJBTlRJRVMgT0YgTUVSQ0hBTlRBQklMSVRZLFxuICogRklUTkVTUyBGT1IgQSBQQVJUSUNVTEFSIFBVUlBPU0UgQU5EIE5PTklORlJJTkdFTUVOVC4gIElOIE5PIEVWRU5UIFNIQUxMIFRIRVxuICogQVVUSE9SUyBPUiBDT1BZUklHSFQgSE9MREVSUyBCRSBMSUFCTEUgRk9SIEFOWSBDTEFJTSwgREFNQUdFUyBPUiBPVEhFUlxuICogTElBQklMSVRZLCBXSEVUSEVSIElOIEFOIEFDVElPTiBPRiBDT05UUkFDVCwgVE9SVCBPUiBPVEhFUldJU0UsIEFSSVNJTkcgRlJPTSxcbiAqIE9VVCBPRiBPUiBJTiBDT05ORUNUSU9OIFdJVEggVEhFIFNPRlRXQVJFIE9SIFRIRSBVU0UgT1IgT1RIRVIgREVBTElOR1MgSU5cbiAqIFRIRSBTT0ZUV0FSRS5cbiAqIFxuICovXG5cInVzZSBzdHJpY3RcIjtcbm1vZHVsZS5leHBvcnRzID0gZnVuY3Rpb24oUHJvbWlzZSwgSU5URVJOQUwpIHtcbnZhciBUSElTID0ge307XG52YXIgdXRpbCA9IHJlcXVpcmUoXCIuL3V0aWwuanNcIik7XG52YXIgbm9kZWJhY2tGb3JQcm9taXNlID0gcmVxdWlyZShcIi4vcHJvbWlzZV9yZXNvbHZlci5qc1wiKVxuICAgIC5fbm9kZWJhY2tGb3JQcm9taXNlO1xudmFyIHdpdGhBcHBlbmRlZCA9IHV0aWwud2l0aEFwcGVuZGVkO1xudmFyIG1heWJlV3JhcEFzRXJyb3IgPSB1dGlsLm1heWJlV3JhcEFzRXJyb3I7XG52YXIgY2FuRXZhbHVhdGUgPSB1dGlsLmNhbkV2YWx1YXRlO1xudmFyIFR5cGVFcnJvciA9IHJlcXVpcmUoXCIuL2Vycm9yc1wiKS5UeXBlRXJyb3I7XG52YXIgZGVmYXVsdFN1ZmZpeCA9IFwiQXN5bmNcIjtcbnZhciBkZWZhdWx0RmlsdGVyID0gZnVuY3Rpb24obmFtZSwgZnVuYykge1xuICAgIHJldHVybiB1dGlsLmlzSWRlbnRpZmllcihuYW1lKSAmJlxuICAgICAgICBuYW1lLmNoYXJBdCgwKSAhPT0gXCJfXCIgJiZcbiAgICAgICAgIXV0aWwuaXNDbGFzcyhmdW5jKTtcbn07XG52YXIgZGVmYXVsdFByb21pc2lmaWVkID0ge19faXNQcm9taXNpZmllZF9fOiB0cnVlfTtcblxuXG5mdW5jdGlvbiBlc2NhcGVJZGVudFJlZ2V4KHN0cikge1xuICAgIHJldHVybiBzdHIucmVwbGFjZSgvKFskXSkvLCBcIlxcXFwkXCIpO1xufVxuXG5mdW5jdGlvbiBpc1Byb21pc2lmaWVkKGZuKSB7XG4gICAgdHJ5IHtcbiAgICAgICAgcmV0dXJuIGZuLl9faXNQcm9taXNpZmllZF9fID09PSB0cnVlO1xuICAgIH1cbiAgICBjYXRjaCAoZSkge1xuICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgfVxufVxuXG5mdW5jdGlvbiBoYXNQcm9taXNpZmllZChvYmosIGtleSwgc3VmZml4KSB7XG4gICAgdmFyIHZhbCA9IHV0aWwuZ2V0RGF0YVByb3BlcnR5T3JEZWZhdWx0KG9iaiwga2V5ICsgc3VmZml4LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBkZWZhdWx0UHJvbWlzaWZpZWQpO1xuICAgIHJldHVybiB2YWwgPyBpc1Byb21pc2lmaWVkKHZhbCkgOiBmYWxzZTtcbn1cbmZ1bmN0aW9uIGNoZWNrVmFsaWQocmV0LCBzdWZmaXgsIHN1ZmZpeFJlZ2V4cCkge1xuICAgIGZvciAodmFyIGkgPSAwOyBpIDwgcmV0Lmxlbmd0aDsgaSArPSAyKSB7XG4gICAgICAgIHZhciBrZXkgPSByZXRbaV07XG4gICAgICAgIGlmIChzdWZmaXhSZWdleHAudGVzdChrZXkpKSB7XG4gICAgICAgICAgICB2YXIga2V5V2l0aG91dEFzeW5jU3VmZml4ID0ga2V5LnJlcGxhY2Uoc3VmZml4UmVnZXhwLCBcIlwiKTtcbiAgICAgICAgICAgIGZvciAodmFyIGogPSAwOyBqIDwgcmV0Lmxlbmd0aDsgaiArPSAyKSB7XG4gICAgICAgICAgICAgICAgaWYgKHJldFtqXSA9PT0ga2V5V2l0aG91dEFzeW5jU3VmZml4KSB7XG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBUeXBlRXJyb3IoXCJDYW5ub3QgcHJvbWlzaWZ5IGFuIEFQSSBcIiArXG4gICAgICAgICAgICAgICAgICAgICAgICBcInRoYXQgaGFzIG5vcm1hbCBtZXRob2RzIHdpdGggJ1wiK3N1ZmZpeCtcIictc3VmZml4XCIpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgIH1cbn1cblxuZnVuY3Rpb24gcHJvbWlzaWZpYWJsZU1ldGhvZHMob2JqLCBzdWZmaXgsIHN1ZmZpeFJlZ2V4cCwgZmlsdGVyKSB7XG4gICAgdmFyIGtleXMgPSB1dGlsLmluaGVyaXRlZERhdGFLZXlzKG9iaik7XG4gICAgdmFyIHJldCA9IFtdO1xuICAgIGZvciAodmFyIGkgPSAwOyBpIDwga2V5cy5sZW5ndGg7ICsraSkge1xuICAgICAgICB2YXIga2V5ID0ga2V5c1tpXTtcbiAgICAgICAgdmFyIHZhbHVlID0gb2JqW2tleV07XG4gICAgICAgIGlmICh0eXBlb2YgdmFsdWUgPT09IFwiZnVuY3Rpb25cIiAmJlxuICAgICAgICAgICAgIWlzUHJvbWlzaWZpZWQodmFsdWUpICYmXG4gICAgICAgICAgICAhaGFzUHJvbWlzaWZpZWQob2JqLCBrZXksIHN1ZmZpeCkgJiZcbiAgICAgICAgICAgIGZpbHRlcihrZXksIHZhbHVlLCBvYmopKSB7XG4gICAgICAgICAgICByZXQucHVzaChrZXksIHZhbHVlKTtcbiAgICAgICAgfVxuICAgIH1cbiAgICBjaGVja1ZhbGlkKHJldCwgc3VmZml4LCBzdWZmaXhSZWdleHApO1xuICAgIHJldHVybiByZXQ7XG59XG5cbmZ1bmN0aW9uIHN3aXRjaENhc2VBcmd1bWVudE9yZGVyKGxpa2VseUFyZ3VtZW50Q291bnQpIHtcbiAgICB2YXIgcmV0ID0gW2xpa2VseUFyZ3VtZW50Q291bnRdO1xuICAgIHZhciBtaW4gPSBNYXRoLm1heCgwLCBsaWtlbHlBcmd1bWVudENvdW50IC0gMSAtIDUpO1xuICAgIGZvcih2YXIgaSA9IGxpa2VseUFyZ3VtZW50Q291bnQgLSAxOyBpID49IG1pbjsgLS1pKSB7XG4gICAgICAgIGlmIChpID09PSBsaWtlbHlBcmd1bWVudENvdW50KSBjb250aW51ZTtcbiAgICAgICAgcmV0LnB1c2goaSk7XG4gICAgfVxuICAgIGZvcih2YXIgaSA9IGxpa2VseUFyZ3VtZW50Q291bnQgKyAxOyBpIDw9IDU7ICsraSkge1xuICAgICAgICByZXQucHVzaChpKTtcbiAgICB9XG4gICAgcmV0dXJuIHJldDtcbn1cblxuZnVuY3Rpb24gYXJndW1lbnRTZXF1ZW5jZShhcmd1bWVudENvdW50KSB7XG4gICAgcmV0dXJuIHV0aWwuZmlsbGVkUmFuZ2UoYXJndW1lbnRDb3VudCwgXCJhcmd1bWVudHNbXCIsIFwiXVwiKTtcbn1cblxuZnVuY3Rpb24gcGFyYW1ldGVyRGVjbGFyYXRpb24ocGFyYW1ldGVyQ291bnQpIHtcbiAgICByZXR1cm4gdXRpbC5maWxsZWRSYW5nZShwYXJhbWV0ZXJDb3VudCwgXCJfYXJnXCIsIFwiXCIpO1xufVxuXG5mdW5jdGlvbiBwYXJhbWV0ZXJDb3VudChmbikge1xuICAgIGlmICh0eXBlb2YgZm4ubGVuZ3RoID09PSBcIm51bWJlclwiKSB7XG4gICAgICAgIHJldHVybiBNYXRoLm1heChNYXRoLm1pbihmbi5sZW5ndGgsIDEwMjMgKyAxKSwgMCk7XG4gICAgfVxuICAgIHJldHVybiAwO1xufVxuXG5mdW5jdGlvbiBnZW5lcmF0ZVByb3BlcnR5QWNjZXNzKGtleSkge1xuICAgIGlmICh1dGlsLmlzSWRlbnRpZmllcihrZXkpKSB7XG4gICAgICAgIHJldHVybiBcIi5cIiArIGtleTtcbiAgICB9XG4gICAgZWxzZSByZXR1cm4gXCJbJ1wiICsga2V5LnJlcGxhY2UoLyhbJ1xcXFxdKS9nLCBcIlxcXFwkMVwiKSArIFwiJ11cIjtcbn1cblxuZnVuY3Rpb24gbWFrZU5vZGVQcm9taXNpZmllZEV2YWwoY2FsbGJhY2ssIHJlY2VpdmVyLCBvcmlnaW5hbE5hbWUsIGZuLCBzdWZmaXgpIHtcbiAgICB2YXIgbmV3UGFyYW1ldGVyQ291bnQgPSBNYXRoLm1heCgwLCBwYXJhbWV0ZXJDb3VudChmbikgLSAxKTtcbiAgICB2YXIgYXJndW1lbnRPcmRlciA9IHN3aXRjaENhc2VBcmd1bWVudE9yZGVyKG5ld1BhcmFtZXRlckNvdW50KTtcbiAgICB2YXIgY2FsbGJhY2tOYW1lID1cbiAgICAgICAgKHR5cGVvZiBvcmlnaW5hbE5hbWUgPT09IFwic3RyaW5nXCIgJiYgdXRpbC5pc0lkZW50aWZpZXIob3JpZ2luYWxOYW1lKVxuICAgICAgICAgICAgPyBvcmlnaW5hbE5hbWUgKyBzdWZmaXhcbiAgICAgICAgICAgIDogXCJwcm9taXNpZmllZFwiKTtcblxuICAgIGZ1bmN0aW9uIGdlbmVyYXRlQ2FsbEZvckFyZ3VtZW50Q291bnQoY291bnQpIHtcbiAgICAgICAgdmFyIGFyZ3MgPSBhcmd1bWVudFNlcXVlbmNlKGNvdW50KS5qb2luKFwiLCBcIik7XG4gICAgICAgIHZhciBjb21tYSA9IGNvdW50ID4gMCA/IFwiLCBcIiA6IFwiXCI7XG4gICAgICAgIHZhciByZXQ7XG4gICAgICAgIGlmICh0eXBlb2YgY2FsbGJhY2sgPT09IFwic3RyaW5nXCIpIHtcbiAgICAgICAgICAgIHJldCA9IFwiICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxcblxcXG4gICAgICAgICAgICAgICAgdGhpcy5tZXRob2Qoe3thcmdzfX0sIGZuKTsgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxcblxcXG4gICAgICAgICAgICAgICAgYnJlYWs7ICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxcblxcXG4gICAgICAgICAgICBcIi5yZXBsYWNlKFwiLm1ldGhvZFwiLCBnZW5lcmF0ZVByb3BlcnR5QWNjZXNzKGNhbGxiYWNrKSk7XG4gICAgICAgIH0gZWxzZSBpZiAocmVjZWl2ZXIgPT09IFRISVMpIHtcbiAgICAgICAgICAgIHJldCA9ICBcIiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxcblxcXG4gICAgICAgICAgICAgICAgY2FsbGJhY2suY2FsbCh0aGlzLCB7e2FyZ3N9fSwgZm4pOyAgICAgICAgICAgICAgICAgICAgICAgICAgIFxcblxcXG4gICAgICAgICAgICAgICAgYnJlYWs7ICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxcblxcXG4gICAgICAgICAgICBcIjtcbiAgICAgICAgfSBlbHNlIGlmIChyZWNlaXZlciAhPT0gdm9pZCAwKSB7XG4gICAgICAgICAgICByZXQgPSAgXCIgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcXG5cXFxuICAgICAgICAgICAgICAgIGNhbGxiYWNrLmNhbGwocmVjZWl2ZXIsIHt7YXJnc319LCBmbik7ICAgICAgICAgICAgICAgICAgICAgICBcXG5cXFxuICAgICAgICAgICAgICAgIGJyZWFrOyAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcXG5cXFxuICAgICAgICAgICAgXCI7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICByZXQgPSAgXCIgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcXG5cXFxuICAgICAgICAgICAgICAgIGNhbGxiYWNrKHt7YXJnc319LCBmbik7ICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcXG5cXFxuICAgICAgICAgICAgICAgIGJyZWFrOyAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcXG5cXFxuICAgICAgICAgICAgXCI7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIHJldC5yZXBsYWNlKFwie3thcmdzfX1cIiwgYXJncykucmVwbGFjZShcIiwgXCIsIGNvbW1hKTtcbiAgICB9XG5cbiAgICBmdW5jdGlvbiBnZW5lcmF0ZUFyZ3VtZW50U3dpdGNoQ2FzZSgpIHtcbiAgICAgICAgdmFyIHJldCA9IFwiXCI7XG4gICAgICAgIGZvcih2YXIgaSA9IDA7IGkgPCBhcmd1bWVudE9yZGVyLmxlbmd0aDsgKytpKSB7XG4gICAgICAgICAgICByZXQgKz0gXCJjYXNlIFwiICsgYXJndW1lbnRPcmRlcltpXSArXCI6XCIgK1xuICAgICAgICAgICAgICAgIGdlbmVyYXRlQ2FsbEZvckFyZ3VtZW50Q291bnQoYXJndW1lbnRPcmRlcltpXSk7XG4gICAgICAgIH1cbiAgICAgICAgdmFyIGNvZGVGb3JDYWxsO1xuICAgICAgICBpZiAodHlwZW9mIGNhbGxiYWNrID09PSBcInN0cmluZ1wiKSB7XG4gICAgICAgICAgICBjb2RlRm9yQ2FsbCA9IFwiICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcXG5cXFxuICAgICAgICAgICAgICAgIHRoaXMucHJvcGVydHkuYXBwbHkodGhpcywgYXJncyk7ICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcXG5cXFxuICAgICAgICAgICAgXCJcbiAgICAgICAgICAgICAgICAucmVwbGFjZShcIi5wcm9wZXJ0eVwiLCBnZW5lcmF0ZVByb3BlcnR5QWNjZXNzKGNhbGxiYWNrKSk7XG4gICAgICAgIH0gZWxzZSBpZiAocmVjZWl2ZXIgPT09IFRISVMpIHtcbiAgICAgICAgICAgIGNvZGVGb3JDYWxsID0gXCIgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxcblxcXG4gICAgICAgICAgICAgICAgY2FsbGJhY2suYXBwbHkodGhpcywgYXJncyk7ICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxcblxcXG4gICAgICAgICAgICBcIjtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIGNvZGVGb3JDYWxsID0gXCIgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxcblxcXG4gICAgICAgICAgICAgICAgY2FsbGJhY2suYXBwbHkocmVjZWl2ZXIsIGFyZ3MpOyAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxcblxcXG4gICAgICAgICAgICBcIjtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldCArPSBcIiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcXG5cXFxuICAgICAgICBkZWZhdWx0OiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcXG5cXFxuICAgICAgICAgICAgdmFyIGFyZ3MgPSBuZXcgQXJyYXkobGVuICsgMSk7ICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcXG5cXFxuICAgICAgICAgICAgdmFyIGkgPSAwOyAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcXG5cXFxuICAgICAgICAgICAgZm9yICh2YXIgaSA9IDA7IGkgPCBsZW47ICsraSkgeyAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcXG5cXFxuICAgICAgICAgICAgICAgYXJnc1tpXSA9IGFyZ3VtZW50c1tpXTsgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcXG5cXFxuICAgICAgICAgICAgfSAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcXG5cXFxuICAgICAgICAgICAgYXJnc1tpXSA9IGZuOyAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcXG5cXFxuICAgICAgICAgICAgW0NvZGVGb3JDYWxsXSAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcXG5cXFxuICAgICAgICAgICAgYnJlYWs7ICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcXG5cXFxuICAgICAgICBcIi5yZXBsYWNlKFwiW0NvZGVGb3JDYWxsXVwiLCBjb2RlRm9yQ2FsbCk7XG4gICAgICAgIHJldHVybiByZXQ7XG4gICAgfVxuXG4gICAgcmV0dXJuIG5ldyBGdW5jdGlvbihcIlByb21pc2VcIixcbiAgICAgICAgICAgICAgICAgICAgICAgIFwiY2FsbGJhY2tcIixcbiAgICAgICAgICAgICAgICAgICAgICAgIFwicmVjZWl2ZXJcIixcbiAgICAgICAgICAgICAgICAgICAgICAgIFwid2l0aEFwcGVuZGVkXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICBcIm1heWJlV3JhcEFzRXJyb3JcIixcbiAgICAgICAgICAgICAgICAgICAgICAgIFwibm9kZWJhY2tGb3JQcm9taXNlXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICBcIklOVEVSTkFMXCIsXCIgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxcblxcXG4gICAgICAgIHZhciByZXQgPSBmdW5jdGlvbiBGdW5jdGlvbk5hbWUoUGFyYW1ldGVycykgeyAgICAgICAgICAgICAgICAgICAgICAgIFxcblxcXG4gICAgICAgICAgICAndXNlIHN0cmljdCc7ICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxcblxcXG4gICAgICAgICAgICB2YXIgbGVuID0gYXJndW1lbnRzLmxlbmd0aDsgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxcblxcXG4gICAgICAgICAgICB2YXIgcHJvbWlzZSA9IG5ldyBQcm9taXNlKElOVEVSTkFMKTsgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxcblxcXG4gICAgICAgICAgICBwcm9taXNlLl9zZXRUcmFjZSh2b2lkIDApOyAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxcblxcXG4gICAgICAgICAgICB2YXIgZm4gPSBub2RlYmFja0ZvclByb21pc2UocHJvbWlzZSk7ICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxcblxcXG4gICAgICAgICAgICB0cnkgeyAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxcblxcXG4gICAgICAgICAgICAgICAgc3dpdGNoKGxlbikgeyAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxcblxcXG4gICAgICAgICAgICAgICAgICAgIFtDb2RlRm9yU3dpdGNoQ2FzZV0gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxcblxcXG4gICAgICAgICAgICAgICAgfSAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxcblxcXG4gICAgICAgICAgICB9IGNhdGNoIChlKSB7ICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxcblxcXG4gICAgICAgICAgICAgICAgdmFyIHdyYXBwZWQgPSBtYXliZVdyYXBBc0Vycm9yKGUpOyAgICAgICAgICAgICAgICAgICAgICAgICAgIFxcblxcXG4gICAgICAgICAgICAgICAgcHJvbWlzZS5fYXR0YWNoRXh0cmFUcmFjZSh3cmFwcGVkKTsgICAgICAgICAgICAgICAgICAgICAgICAgIFxcblxcXG4gICAgICAgICAgICAgICAgcHJvbWlzZS5fcmVqZWN0KHdyYXBwZWQpOyAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxcblxcXG4gICAgICAgICAgICB9ICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxcblxcXG4gICAgICAgICAgICByZXR1cm4gcHJvbWlzZTsgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxcblxcXG4gICAgICAgIH07ICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxcblxcXG4gICAgICAgIHJldC5fX2lzUHJvbWlzaWZpZWRfXyA9IHRydWU7ICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxcblxcXG4gICAgICAgIHJldHVybiByZXQ7ICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxcblxcXG4gICAgICAgIFwiXG4gICAgICAgIC5yZXBsYWNlKFwiRnVuY3Rpb25OYW1lXCIsIGNhbGxiYWNrTmFtZSlcbiAgICAgICAgLnJlcGxhY2UoXCJQYXJhbWV0ZXJzXCIsIHBhcmFtZXRlckRlY2xhcmF0aW9uKG5ld1BhcmFtZXRlckNvdW50KSlcbiAgICAgICAgLnJlcGxhY2UoXCJbQ29kZUZvclN3aXRjaENhc2VdXCIsIGdlbmVyYXRlQXJndW1lbnRTd2l0Y2hDYXNlKCkpKShcbiAgICAgICAgICAgIFByb21pc2UsXG4gICAgICAgICAgICBjYWxsYmFjayxcbiAgICAgICAgICAgIHJlY2VpdmVyLFxuICAgICAgICAgICAgd2l0aEFwcGVuZGVkLFxuICAgICAgICAgICAgbWF5YmVXcmFwQXNFcnJvcixcbiAgICAgICAgICAgIG5vZGViYWNrRm9yUHJvbWlzZSxcbiAgICAgICAgICAgIElOVEVSTkFMXG4gICAgICAgICk7XG59XG5cbmZ1bmN0aW9uIG1ha2VOb2RlUHJvbWlzaWZpZWRDbG9zdXJlKGNhbGxiYWNrLCByZWNlaXZlcikge1xuICAgIGZ1bmN0aW9uIHByb21pc2lmaWVkKCkge1xuICAgICAgICB2YXIgX3JlY2VpdmVyID0gcmVjZWl2ZXI7XG4gICAgICAgIGlmIChyZWNlaXZlciA9PT0gVEhJUykgX3JlY2VpdmVyID0gdGhpcztcbiAgICAgICAgaWYgKHR5cGVvZiBjYWxsYmFjayA9PT0gXCJzdHJpbmdcIikge1xuICAgICAgICAgICAgY2FsbGJhY2sgPSBfcmVjZWl2ZXJbY2FsbGJhY2tdO1xuICAgICAgICB9XG4gICAgICAgIHZhciBwcm9taXNlID0gbmV3IFByb21pc2UoSU5URVJOQUwpO1xuICAgICAgICBwcm9taXNlLl9zZXRUcmFjZSh2b2lkIDApO1xuICAgICAgICB2YXIgZm4gPSBub2RlYmFja0ZvclByb21pc2UocHJvbWlzZSk7XG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgICBjYWxsYmFjay5hcHBseShfcmVjZWl2ZXIsIHdpdGhBcHBlbmRlZChhcmd1bWVudHMsIGZuKSk7XG4gICAgICAgIH0gY2F0Y2goZSkge1xuICAgICAgICAgICAgdmFyIHdyYXBwZWQgPSBtYXliZVdyYXBBc0Vycm9yKGUpO1xuICAgICAgICAgICAgcHJvbWlzZS5fYXR0YWNoRXh0cmFUcmFjZSh3cmFwcGVkKTtcbiAgICAgICAgICAgIHByb21pc2UuX3JlamVjdCh3cmFwcGVkKTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gcHJvbWlzZTtcbiAgICB9XG4gICAgcHJvbWlzaWZpZWQuX19pc1Byb21pc2lmaWVkX18gPSB0cnVlO1xuICAgIHJldHVybiBwcm9taXNpZmllZDtcbn1cblxudmFyIG1ha2VOb2RlUHJvbWlzaWZpZWQgPSBjYW5FdmFsdWF0ZVxuICAgID8gbWFrZU5vZGVQcm9taXNpZmllZEV2YWxcbiAgICA6IG1ha2VOb2RlUHJvbWlzaWZpZWRDbG9zdXJlO1xuXG5mdW5jdGlvbiBwcm9taXNpZnlBbGwob2JqLCBzdWZmaXgsIGZpbHRlciwgcHJvbWlzaWZpZXIpIHtcbiAgICB2YXIgc3VmZml4UmVnZXhwID0gbmV3IFJlZ0V4cChlc2NhcGVJZGVudFJlZ2V4KHN1ZmZpeCkgKyBcIiRcIik7XG4gICAgdmFyIG1ldGhvZHMgPVxuICAgICAgICBwcm9taXNpZmlhYmxlTWV0aG9kcyhvYmosIHN1ZmZpeCwgc3VmZml4UmVnZXhwLCBmaWx0ZXIpO1xuXG4gICAgZm9yICh2YXIgaSA9IDAsIGxlbiA9IG1ldGhvZHMubGVuZ3RoOyBpIDwgbGVuOyBpKz0gMikge1xuICAgICAgICB2YXIga2V5ID0gbWV0aG9kc1tpXTtcbiAgICAgICAgdmFyIGZuID0gbWV0aG9kc1tpKzFdO1xuICAgICAgICB2YXIgcHJvbWlzaWZpZWRLZXkgPSBrZXkgKyBzdWZmaXg7XG4gICAgICAgIG9ialtwcm9taXNpZmllZEtleV0gPSBwcm9taXNpZmllciA9PT0gbWFrZU5vZGVQcm9taXNpZmllZFxuICAgICAgICAgICAgICAgID8gbWFrZU5vZGVQcm9taXNpZmllZChrZXksIFRISVMsIGtleSwgZm4sIHN1ZmZpeClcbiAgICAgICAgICAgICAgICA6IHByb21pc2lmaWVyKGZuKTtcbiAgICB9XG4gICAgdXRpbC50b0Zhc3RQcm9wZXJ0aWVzKG9iaik7XG4gICAgcmV0dXJuIG9iajtcbn1cblxuZnVuY3Rpb24gcHJvbWlzaWZ5KGNhbGxiYWNrLCByZWNlaXZlcikge1xuICAgIHJldHVybiBtYWtlTm9kZVByb21pc2lmaWVkKGNhbGxiYWNrLCByZWNlaXZlciwgdm9pZCAwLCBjYWxsYmFjayk7XG59XG5cblByb21pc2UucHJvbWlzaWZ5ID0gZnVuY3Rpb24gUHJvbWlzZSRQcm9taXNpZnkoZm4sIHJlY2VpdmVyKSB7XG4gICAgaWYgKHR5cGVvZiBmbiAhPT0gXCJmdW5jdGlvblwiKSB7XG4gICAgICAgIHRocm93IG5ldyBUeXBlRXJyb3IoXCJmbiBtdXN0IGJlIGEgZnVuY3Rpb25cIik7XG4gICAgfVxuICAgIGlmIChpc1Byb21pc2lmaWVkKGZuKSkge1xuICAgICAgICByZXR1cm4gZm47XG4gICAgfVxuICAgIHJldHVybiBwcm9taXNpZnkoZm4sIGFyZ3VtZW50cy5sZW5ndGggPCAyID8gVEhJUyA6IHJlY2VpdmVyKTtcbn07XG5cblByb21pc2UucHJvbWlzaWZ5QWxsID0gZnVuY3Rpb24gUHJvbWlzZSRQcm9taXNpZnlBbGwodGFyZ2V0LCBvcHRpb25zKSB7XG4gICAgaWYgKHR5cGVvZiB0YXJnZXQgIT09IFwiZnVuY3Rpb25cIiAmJiB0eXBlb2YgdGFyZ2V0ICE9PSBcIm9iamVjdFwiKSB7XG4gICAgICAgIHRocm93IG5ldyBUeXBlRXJyb3IoXCJ0aGUgdGFyZ2V0IG9mIHByb21pc2lmeUFsbCBtdXN0IGJlIGFuIG9iamVjdCBvciBhIGZ1bmN0aW9uXCIpO1xuICAgIH1cbiAgICBvcHRpb25zID0gT2JqZWN0KG9wdGlvbnMpO1xuICAgIHZhciBzdWZmaXggPSBvcHRpb25zLnN1ZmZpeDtcbiAgICBpZiAodHlwZW9mIHN1ZmZpeCAhPT0gXCJzdHJpbmdcIikgc3VmZml4ID0gZGVmYXVsdFN1ZmZpeDtcbiAgICB2YXIgZmlsdGVyID0gb3B0aW9ucy5maWx0ZXI7XG4gICAgaWYgKHR5cGVvZiBmaWx0ZXIgIT09IFwiZnVuY3Rpb25cIikgZmlsdGVyID0gZGVmYXVsdEZpbHRlcjtcbiAgICB2YXIgcHJvbWlzaWZpZXIgPSBvcHRpb25zLnByb21pc2lmaWVyO1xuICAgIGlmICh0eXBlb2YgcHJvbWlzaWZpZXIgIT09IFwiZnVuY3Rpb25cIikgcHJvbWlzaWZpZXIgPSBtYWtlTm9kZVByb21pc2lmaWVkO1xuXG4gICAgaWYgKCF1dGlsLmlzSWRlbnRpZmllcihzdWZmaXgpKSB7XG4gICAgICAgIHRocm93IG5ldyBSYW5nZUVycm9yKFwic3VmZml4IG11c3QgYmUgYSB2YWxpZCBpZGVudGlmaWVyXCIpO1xuICAgIH1cblxuICAgIHZhciBrZXlzID0gdXRpbC5pbmhlcml0ZWREYXRhS2V5cyh0YXJnZXQsIHtpbmNsdWRlSGlkZGVuOiB0cnVlfSk7XG4gICAgZm9yICh2YXIgaSA9IDA7IGkgPCBrZXlzLmxlbmd0aDsgKytpKSB7XG4gICAgICAgIHZhciB2YWx1ZSA9IHRhcmdldFtrZXlzW2ldXTtcbiAgICAgICAgaWYgKGtleXNbaV0gIT09IFwiY29uc3RydWN0b3JcIiAmJlxuICAgICAgICAgICAgdXRpbC5pc0NsYXNzKHZhbHVlKSkge1xuICAgICAgICAgICAgcHJvbWlzaWZ5QWxsKHZhbHVlLnByb3RvdHlwZSwgc3VmZml4LCBmaWx0ZXIsIHByb21pc2lmaWVyKTtcbiAgICAgICAgICAgIHByb21pc2lmeUFsbCh2YWx1ZSwgc3VmZml4LCBmaWx0ZXIsIHByb21pc2lmaWVyKTtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIHJldHVybiBwcm9taXNpZnlBbGwodGFyZ2V0LCBzdWZmaXgsIGZpbHRlciwgcHJvbWlzaWZpZXIpO1xufTtcbn07XG5cbiIsIi8qKlxuICogVGhlIE1JVCBMaWNlbnNlIChNSVQpXG4gKiBcbiAqIENvcHlyaWdodCAoYykgMjAxNCBQZXRrYSBBbnRvbm92XG4gKiBcbiAqIFBlcm1pc3Npb24gaXMgaGVyZWJ5IGdyYW50ZWQsIGZyZWUgb2YgY2hhcmdlLCB0byBhbnkgcGVyc29uIG9idGFpbmluZyBhIGNvcHlcbiAqIG9mIHRoaXMgc29mdHdhcmUgYW5kIGFzc29jaWF0ZWQgZG9jdW1lbnRhdGlvbiBmaWxlcyAodGhlIFwiU29mdHdhcmVcIiksIHRvIGRlYWxcbiAqIGluIHRoZSBTb2Z0d2FyZSB3aXRob3V0IHJlc3RyaWN0aW9uLCBpbmNsdWRpbmcgd2l0aG91dCBsaW1pdGF0aW9uIHRoZSByaWdodHNcbiAqIHRvIHVzZSwgY29weSwgbW9kaWZ5LCBtZXJnZSwgcHVibGlzaCwgZGlzdHJpYnV0ZSwgc3VibGljZW5zZSwgYW5kL29yIHNlbGxcbiAqIGNvcGllcyBvZiB0aGUgU29mdHdhcmUsIGFuZCB0byBwZXJtaXQgcGVyc29ucyB0byB3aG9tIHRoZSBTb2Z0d2FyZSBpc1xuICogZnVybmlzaGVkIHRvIGRvIHNvLCBzdWJqZWN0IHRvIHRoZSBmb2xsb3dpbmcgY29uZGl0aW9uczo8L3A+XG4gKiBcbiAqIFRoZSBhYm92ZSBjb3B5cmlnaHQgbm90aWNlIGFuZCB0aGlzIHBlcm1pc3Npb24gbm90aWNlIHNoYWxsIGJlIGluY2x1ZGVkIGluXG4gKiBhbGwgY29waWVzIG9yIHN1YnN0YW50aWFsIHBvcnRpb25zIG9mIHRoZSBTb2Z0d2FyZS5cbiAqIFxuICogVEhFIFNPRlRXQVJFIElTIFBST1ZJREVEIFwiQVMgSVNcIiwgV0lUSE9VVCBXQVJSQU5UWSBPRiBBTlkgS0lORCwgRVhQUkVTUyBPUlxuICogSU1QTElFRCwgSU5DTFVESU5HIEJVVCBOT1QgTElNSVRFRCBUTyBUSEUgV0FSUkFOVElFUyBPRiBNRVJDSEFOVEFCSUxJVFksXG4gKiBGSVRORVNTIEZPUiBBIFBBUlRJQ1VMQVIgUFVSUE9TRSBBTkQgTk9OSU5GUklOR0VNRU5ULiAgSU4gTk8gRVZFTlQgU0hBTEwgVEhFXG4gKiBBVVRIT1JTIE9SIENPUFlSSUdIVCBIT0xERVJTIEJFIExJQUJMRSBGT1IgQU5ZIENMQUlNLCBEQU1BR0VTIE9SIE9USEVSXG4gKiBMSUFCSUxJVFksIFdIRVRIRVIgSU4gQU4gQUNUSU9OIE9GIENPTlRSQUNULCBUT1JUIE9SIE9USEVSV0lTRSwgQVJJU0lORyBGUk9NLFxuICogT1VUIE9GIE9SIElOIENPTk5FQ1RJT04gV0lUSCBUSEUgU09GVFdBUkUgT1IgVEhFIFVTRSBPUiBPVEhFUiBERUFMSU5HUyBJTlxuICogVEhFIFNPRlRXQVJFLlxuICogXG4gKi9cblwidXNlIHN0cmljdFwiO1xubW9kdWxlLmV4cG9ydHMgPSBmdW5jdGlvbihQcm9taXNlLCBQcm9taXNlQXJyYXksIGNhc3QpIHtcbnZhciB1dGlsID0gcmVxdWlyZShcIi4vdXRpbC5qc1wiKTtcbnZhciBhcGlSZWplY3Rpb24gPSByZXF1aXJlKFwiLi9lcnJvcnNfYXBpX3JlamVjdGlvblwiKShQcm9taXNlKTtcbnZhciBpc09iamVjdCA9IHV0aWwuaXNPYmplY3Q7XG52YXIgZXM1ID0gcmVxdWlyZShcIi4vZXM1LmpzXCIpO1xuXG5mdW5jdGlvbiBQcm9wZXJ0aWVzUHJvbWlzZUFycmF5KG9iaikge1xuICAgIHZhciBrZXlzID0gZXM1LmtleXMob2JqKTtcbiAgICB2YXIgbGVuID0ga2V5cy5sZW5ndGg7XG4gICAgdmFyIHZhbHVlcyA9IG5ldyBBcnJheShsZW4gKiAyKTtcbiAgICBmb3IgKHZhciBpID0gMDsgaSA8IGxlbjsgKytpKSB7XG4gICAgICAgIHZhciBrZXkgPSBrZXlzW2ldO1xuICAgICAgICB2YWx1ZXNbaV0gPSBvYmpba2V5XTtcbiAgICAgICAgdmFsdWVzW2kgKyBsZW5dID0ga2V5O1xuICAgIH1cbiAgICB0aGlzLmNvbnN0cnVjdG9yJCh2YWx1ZXMpO1xufVxudXRpbC5pbmhlcml0cyhQcm9wZXJ0aWVzUHJvbWlzZUFycmF5LCBQcm9taXNlQXJyYXkpO1xuXG5Qcm9wZXJ0aWVzUHJvbWlzZUFycmF5LnByb3RvdHlwZS5faW5pdCA9XG5mdW5jdGlvbiBQcm9wZXJ0aWVzUHJvbWlzZUFycmF5JF9pbml0KCkge1xuICAgIHRoaXMuX2luaXQkKHZvaWQgMCwgLTMpIDtcbn07XG5cblByb3BlcnRpZXNQcm9taXNlQXJyYXkucHJvdG90eXBlLl9wcm9taXNlRnVsZmlsbGVkID1cbmZ1bmN0aW9uIFByb3BlcnRpZXNQcm9taXNlQXJyYXkkX3Byb21pc2VGdWxmaWxsZWQodmFsdWUsIGluZGV4KSB7XG4gICAgaWYgKHRoaXMuX2lzUmVzb2x2ZWQoKSkgcmV0dXJuO1xuICAgIHRoaXMuX3ZhbHVlc1tpbmRleF0gPSB2YWx1ZTtcbiAgICB2YXIgdG90YWxSZXNvbHZlZCA9ICsrdGhpcy5fdG90YWxSZXNvbHZlZDtcbiAgICBpZiAodG90YWxSZXNvbHZlZCA+PSB0aGlzLl9sZW5ndGgpIHtcbiAgICAgICAgdmFyIHZhbCA9IHt9O1xuICAgICAgICB2YXIga2V5T2Zmc2V0ID0gdGhpcy5sZW5ndGgoKTtcbiAgICAgICAgZm9yICh2YXIgaSA9IDAsIGxlbiA9IHRoaXMubGVuZ3RoKCk7IGkgPCBsZW47ICsraSkge1xuICAgICAgICAgICAgdmFsW3RoaXMuX3ZhbHVlc1tpICsga2V5T2Zmc2V0XV0gPSB0aGlzLl92YWx1ZXNbaV07XG4gICAgICAgIH1cbiAgICAgICAgdGhpcy5fcmVzb2x2ZSh2YWwpO1xuICAgIH1cbn07XG5cblByb3BlcnRpZXNQcm9taXNlQXJyYXkucHJvdG90eXBlLl9wcm9taXNlUHJvZ3Jlc3NlZCA9XG5mdW5jdGlvbiBQcm9wZXJ0aWVzUHJvbWlzZUFycmF5JF9wcm9taXNlUHJvZ3Jlc3NlZCh2YWx1ZSwgaW5kZXgpIHtcbiAgICBpZiAodGhpcy5faXNSZXNvbHZlZCgpKSByZXR1cm47XG5cbiAgICB0aGlzLl9wcm9taXNlLl9wcm9ncmVzcyh7XG4gICAgICAgIGtleTogdGhpcy5fdmFsdWVzW2luZGV4ICsgdGhpcy5sZW5ndGgoKV0sXG4gICAgICAgIHZhbHVlOiB2YWx1ZVxuICAgIH0pO1xufTtcblxuUHJvcGVydGllc1Byb21pc2VBcnJheS5wcm90b3R5cGUuc2hvdWxkQ29weVZhbHVlcyA9XG5mdW5jdGlvbiBQcm9wZXJ0aWVzUHJvbWlzZUFycmF5JF9zaG91bGRDb3B5VmFsdWVzKCkge1xuICAgIHJldHVybiBmYWxzZTtcbn07XG5cblByb3BlcnRpZXNQcm9taXNlQXJyYXkucHJvdG90eXBlLmdldEFjdHVhbExlbmd0aCA9XG5mdW5jdGlvbiBQcm9wZXJ0aWVzUHJvbWlzZUFycmF5JGdldEFjdHVhbExlbmd0aChsZW4pIHtcbiAgICByZXR1cm4gbGVuID4+IDE7XG59O1xuXG5mdW5jdGlvbiBQcm9taXNlJF9Qcm9wcyhwcm9taXNlcykge1xuICAgIHZhciByZXQ7XG4gICAgdmFyIGNhc3RWYWx1ZSA9IGNhc3QocHJvbWlzZXMsIHZvaWQgMCk7XG5cbiAgICBpZiAoIWlzT2JqZWN0KGNhc3RWYWx1ZSkpIHtcbiAgICAgICAgcmV0dXJuIGFwaVJlamVjdGlvbihcImNhbm5vdCBhd2FpdCBwcm9wZXJ0aWVzIG9mIGEgbm9uLW9iamVjdFwiKTtcbiAgICB9IGVsc2UgaWYgKGNhc3RWYWx1ZSBpbnN0YW5jZW9mIFByb21pc2UpIHtcbiAgICAgICAgcmV0ID0gY2FzdFZhbHVlLl90aGVuKFByb21pc2UucHJvcHMsIHZvaWQgMCwgdm9pZCAwLCB2b2lkIDAsIHZvaWQgMCk7XG4gICAgfSBlbHNlIHtcbiAgICAgICAgcmV0ID0gbmV3IFByb3BlcnRpZXNQcm9taXNlQXJyYXkoY2FzdFZhbHVlKS5wcm9taXNlKCk7XG4gICAgfVxuXG4gICAgaWYgKGNhc3RWYWx1ZSBpbnN0YW5jZW9mIFByb21pc2UpIHtcbiAgICAgICAgcmV0Ll9wcm9wYWdhdGVGcm9tKGNhc3RWYWx1ZSwgNCk7XG4gICAgfVxuICAgIHJldHVybiByZXQ7XG59XG5cblByb21pc2UucHJvdG90eXBlLnByb3BzID0gZnVuY3Rpb24gUHJvbWlzZSRwcm9wcygpIHtcbiAgICByZXR1cm4gUHJvbWlzZSRfUHJvcHModGhpcyk7XG59O1xuXG5Qcm9taXNlLnByb3BzID0gZnVuY3Rpb24gUHJvbWlzZSRQcm9wcyhwcm9taXNlcykge1xuICAgIHJldHVybiBQcm9taXNlJF9Qcm9wcyhwcm9taXNlcyk7XG59O1xufTtcbiIsIi8qKlxuICogVGhlIE1JVCBMaWNlbnNlIChNSVQpXG4gKiBcbiAqIENvcHlyaWdodCAoYykgMjAxNCBQZXRrYSBBbnRvbm92XG4gKiBcbiAqIFBlcm1pc3Npb24gaXMgaGVyZWJ5IGdyYW50ZWQsIGZyZWUgb2YgY2hhcmdlLCB0byBhbnkgcGVyc29uIG9idGFpbmluZyBhIGNvcHlcbiAqIG9mIHRoaXMgc29mdHdhcmUgYW5kIGFzc29jaWF0ZWQgZG9jdW1lbnRhdGlvbiBmaWxlcyAodGhlIFwiU29mdHdhcmVcIiksIHRvIGRlYWxcbiAqIGluIHRoZSBTb2Z0d2FyZSB3aXRob3V0IHJlc3RyaWN0aW9uLCBpbmNsdWRpbmcgd2l0aG91dCBsaW1pdGF0aW9uIHRoZSByaWdodHNcbiAqIHRvIHVzZSwgY29weSwgbW9kaWZ5LCBtZXJnZSwgcHVibGlzaCwgZGlzdHJpYnV0ZSwgc3VibGljZW5zZSwgYW5kL29yIHNlbGxcbiAqIGNvcGllcyBvZiB0aGUgU29mdHdhcmUsIGFuZCB0byBwZXJtaXQgcGVyc29ucyB0byB3aG9tIHRoZSBTb2Z0d2FyZSBpc1xuICogZnVybmlzaGVkIHRvIGRvIHNvLCBzdWJqZWN0IHRvIHRoZSBmb2xsb3dpbmcgY29uZGl0aW9uczo8L3A+XG4gKiBcbiAqIFRoZSBhYm92ZSBjb3B5cmlnaHQgbm90aWNlIGFuZCB0aGlzIHBlcm1pc3Npb24gbm90aWNlIHNoYWxsIGJlIGluY2x1ZGVkIGluXG4gKiBhbGwgY29waWVzIG9yIHN1YnN0YW50aWFsIHBvcnRpb25zIG9mIHRoZSBTb2Z0d2FyZS5cbiAqIFxuICogVEhFIFNPRlRXQVJFIElTIFBST1ZJREVEIFwiQVMgSVNcIiwgV0lUSE9VVCBXQVJSQU5UWSBPRiBBTlkgS0lORCwgRVhQUkVTUyBPUlxuICogSU1QTElFRCwgSU5DTFVESU5HIEJVVCBOT1QgTElNSVRFRCBUTyBUSEUgV0FSUkFOVElFUyBPRiBNRVJDSEFOVEFCSUxJVFksXG4gKiBGSVRORVNTIEZPUiBBIFBBUlRJQ1VMQVIgUFVSUE9TRSBBTkQgTk9OSU5GUklOR0VNRU5ULiAgSU4gTk8gRVZFTlQgU0hBTEwgVEhFXG4gKiBBVVRIT1JTIE9SIENPUFlSSUdIVCBIT0xERVJTIEJFIExJQUJMRSBGT1IgQU5ZIENMQUlNLCBEQU1BR0VTIE9SIE9USEVSXG4gKiBMSUFCSUxJVFksIFdIRVRIRVIgSU4gQU4gQUNUSU9OIE9GIENPTlRSQUNULCBUT1JUIE9SIE9USEVSV0lTRSwgQVJJU0lORyBGUk9NLFxuICogT1VUIE9GIE9SIElOIENPTk5FQ1RJT04gV0lUSCBUSEUgU09GVFdBUkUgT1IgVEhFIFVTRSBPUiBPVEhFUiBERUFMSU5HUyBJTlxuICogVEhFIFNPRlRXQVJFLlxuICogXG4gKi9cblwidXNlIHN0cmljdFwiO1xuZnVuY3Rpb24gYXJyYXlDb3B5KHNyYywgc3JjSW5kZXgsIGRzdCwgZHN0SW5kZXgsIGxlbikge1xuICAgIGZvciAodmFyIGogPSAwOyBqIDwgbGVuOyArK2opIHtcbiAgICAgICAgZHN0W2ogKyBkc3RJbmRleF0gPSBzcmNbaiArIHNyY0luZGV4XTtcbiAgICB9XG59XG5cbmZ1bmN0aW9uIFF1ZXVlKGNhcGFjaXR5KSB7XG4gICAgdGhpcy5fY2FwYWNpdHkgPSBjYXBhY2l0eTtcbiAgICB0aGlzLl9sZW5ndGggPSAwO1xuICAgIHRoaXMuX2Zyb250ID0gMDtcbiAgICB0aGlzLl9tYWtlQ2FwYWNpdHkoKTtcbn1cblxuUXVldWUucHJvdG90eXBlLl93aWxsQmVPdmVyQ2FwYWNpdHkgPVxuZnVuY3Rpb24gUXVldWUkX3dpbGxCZU92ZXJDYXBhY2l0eShzaXplKSB7XG4gICAgcmV0dXJuIHRoaXMuX2NhcGFjaXR5IDwgc2l6ZTtcbn07XG5cblF1ZXVlLnByb3RvdHlwZS5fcHVzaE9uZSA9IGZ1bmN0aW9uIFF1ZXVlJF9wdXNoT25lKGFyZykge1xuICAgIHZhciBsZW5ndGggPSB0aGlzLmxlbmd0aCgpO1xuICAgIHRoaXMuX2NoZWNrQ2FwYWNpdHkobGVuZ3RoICsgMSk7XG4gICAgdmFyIGkgPSAodGhpcy5fZnJvbnQgKyBsZW5ndGgpICYgKHRoaXMuX2NhcGFjaXR5IC0gMSk7XG4gICAgdGhpc1tpXSA9IGFyZztcbiAgICB0aGlzLl9sZW5ndGggPSBsZW5ndGggKyAxO1xufTtcblxuUXVldWUucHJvdG90eXBlLnB1c2ggPSBmdW5jdGlvbiBRdWV1ZSRwdXNoKGZuLCByZWNlaXZlciwgYXJnKSB7XG4gICAgdmFyIGxlbmd0aCA9IHRoaXMubGVuZ3RoKCkgKyAzO1xuICAgIGlmICh0aGlzLl93aWxsQmVPdmVyQ2FwYWNpdHkobGVuZ3RoKSkge1xuICAgICAgICB0aGlzLl9wdXNoT25lKGZuKTtcbiAgICAgICAgdGhpcy5fcHVzaE9uZShyZWNlaXZlcik7XG4gICAgICAgIHRoaXMuX3B1c2hPbmUoYXJnKTtcbiAgICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICB2YXIgaiA9IHRoaXMuX2Zyb250ICsgbGVuZ3RoIC0gMztcbiAgICB0aGlzLl9jaGVja0NhcGFjaXR5KGxlbmd0aCk7XG4gICAgdmFyIHdyYXBNYXNrID0gdGhpcy5fY2FwYWNpdHkgLSAxO1xuICAgIHRoaXNbKGogKyAwKSAmIHdyYXBNYXNrXSA9IGZuO1xuICAgIHRoaXNbKGogKyAxKSAmIHdyYXBNYXNrXSA9IHJlY2VpdmVyO1xuICAgIHRoaXNbKGogKyAyKSAmIHdyYXBNYXNrXSA9IGFyZztcbiAgICB0aGlzLl9sZW5ndGggPSBsZW5ndGg7XG59O1xuXG5RdWV1ZS5wcm90b3R5cGUuc2hpZnQgPSBmdW5jdGlvbiBRdWV1ZSRzaGlmdCgpIHtcbiAgICB2YXIgZnJvbnQgPSB0aGlzLl9mcm9udCxcbiAgICAgICAgcmV0ID0gdGhpc1tmcm9udF07XG5cbiAgICB0aGlzW2Zyb250XSA9IHZvaWQgMDtcbiAgICB0aGlzLl9mcm9udCA9IChmcm9udCArIDEpICYgKHRoaXMuX2NhcGFjaXR5IC0gMSk7XG4gICAgdGhpcy5fbGVuZ3RoLS07XG4gICAgcmV0dXJuIHJldDtcbn07XG5cblF1ZXVlLnByb3RvdHlwZS5sZW5ndGggPSBmdW5jdGlvbiBRdWV1ZSRsZW5ndGgoKSB7XG4gICAgcmV0dXJuIHRoaXMuX2xlbmd0aDtcbn07XG5cblF1ZXVlLnByb3RvdHlwZS5fbWFrZUNhcGFjaXR5ID0gZnVuY3Rpb24gUXVldWUkX21ha2VDYXBhY2l0eSgpIHtcbiAgICB2YXIgbGVuID0gdGhpcy5fY2FwYWNpdHk7XG4gICAgZm9yICh2YXIgaSA9IDA7IGkgPCBsZW47ICsraSkge1xuICAgICAgICB0aGlzW2ldID0gdm9pZCAwO1xuICAgIH1cbn07XG5cblF1ZXVlLnByb3RvdHlwZS5fY2hlY2tDYXBhY2l0eSA9IGZ1bmN0aW9uIFF1ZXVlJF9jaGVja0NhcGFjaXR5KHNpemUpIHtcbiAgICBpZiAodGhpcy5fY2FwYWNpdHkgPCBzaXplKSB7XG4gICAgICAgIHRoaXMuX3Jlc2l6ZVRvKHRoaXMuX2NhcGFjaXR5IDw8IDMpO1xuICAgIH1cbn07XG5cblF1ZXVlLnByb3RvdHlwZS5fcmVzaXplVG8gPSBmdW5jdGlvbiBRdWV1ZSRfcmVzaXplVG8oY2FwYWNpdHkpIHtcbiAgICB2YXIgb2xkRnJvbnQgPSB0aGlzLl9mcm9udDtcbiAgICB2YXIgb2xkQ2FwYWNpdHkgPSB0aGlzLl9jYXBhY2l0eTtcbiAgICB2YXIgb2xkUXVldWUgPSBuZXcgQXJyYXkob2xkQ2FwYWNpdHkpO1xuICAgIHZhciBsZW5ndGggPSB0aGlzLmxlbmd0aCgpO1xuXG4gICAgYXJyYXlDb3B5KHRoaXMsIDAsIG9sZFF1ZXVlLCAwLCBvbGRDYXBhY2l0eSk7XG4gICAgdGhpcy5fY2FwYWNpdHkgPSBjYXBhY2l0eTtcbiAgICB0aGlzLl9tYWtlQ2FwYWNpdHkoKTtcbiAgICB0aGlzLl9mcm9udCA9IDA7XG4gICAgaWYgKG9sZEZyb250ICsgbGVuZ3RoIDw9IG9sZENhcGFjaXR5KSB7XG4gICAgICAgIGFycmF5Q29weShvbGRRdWV1ZSwgb2xkRnJvbnQsIHRoaXMsIDAsIGxlbmd0aCk7XG4gICAgfSBlbHNlIHsgICAgICAgIHZhciBsZW5ndGhCZWZvcmVXcmFwcGluZyA9XG4gICAgICAgICAgICBsZW5ndGggLSAoKG9sZEZyb250ICsgbGVuZ3RoKSAmIChvbGRDYXBhY2l0eSAtIDEpKTtcblxuICAgICAgICBhcnJheUNvcHkob2xkUXVldWUsIG9sZEZyb250LCB0aGlzLCAwLCBsZW5ndGhCZWZvcmVXcmFwcGluZyk7XG4gICAgICAgIGFycmF5Q29weShvbGRRdWV1ZSwgMCwgdGhpcywgbGVuZ3RoQmVmb3JlV3JhcHBpbmcsXG4gICAgICAgICAgICAgICAgICAgIGxlbmd0aCAtIGxlbmd0aEJlZm9yZVdyYXBwaW5nKTtcbiAgICB9XG59O1xuXG5tb2R1bGUuZXhwb3J0cyA9IFF1ZXVlO1xuIiwiLyoqXG4gKiBUaGUgTUlUIExpY2Vuc2UgKE1JVClcbiAqIFxuICogQ29weXJpZ2h0IChjKSAyMDE0IFBldGthIEFudG9ub3ZcbiAqIFxuICogUGVybWlzc2lvbiBpcyBoZXJlYnkgZ3JhbnRlZCwgZnJlZSBvZiBjaGFyZ2UsIHRvIGFueSBwZXJzb24gb2J0YWluaW5nIGEgY29weVxuICogb2YgdGhpcyBzb2Z0d2FyZSBhbmQgYXNzb2NpYXRlZCBkb2N1bWVudGF0aW9uIGZpbGVzICh0aGUgXCJTb2Z0d2FyZVwiKSwgdG8gZGVhbFxuICogaW4gdGhlIFNvZnR3YXJlIHdpdGhvdXQgcmVzdHJpY3Rpb24sIGluY2x1ZGluZyB3aXRob3V0IGxpbWl0YXRpb24gdGhlIHJpZ2h0c1xuICogdG8gdXNlLCBjb3B5LCBtb2RpZnksIG1lcmdlLCBwdWJsaXNoLCBkaXN0cmlidXRlLCBzdWJsaWNlbnNlLCBhbmQvb3Igc2VsbFxuICogY29waWVzIG9mIHRoZSBTb2Z0d2FyZSwgYW5kIHRvIHBlcm1pdCBwZXJzb25zIHRvIHdob20gdGhlIFNvZnR3YXJlIGlzXG4gKiBmdXJuaXNoZWQgdG8gZG8gc28sIHN1YmplY3QgdG8gdGhlIGZvbGxvd2luZyBjb25kaXRpb25zOjwvcD5cbiAqIFxuICogVGhlIGFib3ZlIGNvcHlyaWdodCBub3RpY2UgYW5kIHRoaXMgcGVybWlzc2lvbiBub3RpY2Ugc2hhbGwgYmUgaW5jbHVkZWQgaW5cbiAqIGFsbCBjb3BpZXMgb3Igc3Vic3RhbnRpYWwgcG9ydGlvbnMgb2YgdGhlIFNvZnR3YXJlLlxuICogXG4gKiBUSEUgU09GVFdBUkUgSVMgUFJPVklERUQgXCJBUyBJU1wiLCBXSVRIT1VUIFdBUlJBTlRZIE9GIEFOWSBLSU5ELCBFWFBSRVNTIE9SXG4gKiBJTVBMSUVELCBJTkNMVURJTkcgQlVUIE5PVCBMSU1JVEVEIFRPIFRIRSBXQVJSQU5USUVTIE9GIE1FUkNIQU5UQUJJTElUWSxcbiAqIEZJVE5FU1MgRk9SIEEgUEFSVElDVUxBUiBQVVJQT1NFIEFORCBOT05JTkZSSU5HRU1FTlQuICBJTiBOTyBFVkVOVCBTSEFMTCBUSEVcbiAqIEFVVEhPUlMgT1IgQ09QWVJJR0hUIEhPTERFUlMgQkUgTElBQkxFIEZPUiBBTlkgQ0xBSU0sIERBTUFHRVMgT1IgT1RIRVJcbiAqIExJQUJJTElUWSwgV0hFVEhFUiBJTiBBTiBBQ1RJT04gT0YgQ09OVFJBQ1QsIFRPUlQgT1IgT1RIRVJXSVNFLCBBUklTSU5HIEZST00sXG4gKiBPVVQgT0YgT1IgSU4gQ09OTkVDVElPTiBXSVRIIFRIRSBTT0ZUV0FSRSBPUiBUSEUgVVNFIE9SIE9USEVSIERFQUxJTkdTIElOXG4gKiBUSEUgU09GVFdBUkUuXG4gKiBcbiAqL1xuXCJ1c2Ugc3RyaWN0XCI7XG5tb2R1bGUuZXhwb3J0cyA9IGZ1bmN0aW9uKFByb21pc2UsIElOVEVSTkFMLCBjYXN0KSB7XG52YXIgYXBpUmVqZWN0aW9uID0gcmVxdWlyZShcIi4vZXJyb3JzX2FwaV9yZWplY3Rpb24uanNcIikoUHJvbWlzZSk7XG52YXIgaXNBcnJheSA9IHJlcXVpcmUoXCIuL3V0aWwuanNcIikuaXNBcnJheTtcblxudmFyIHJhY2VMYXRlciA9IGZ1bmN0aW9uIFByb21pc2UkX3JhY2VMYXRlcihwcm9taXNlKSB7XG4gICAgcmV0dXJuIHByb21pc2UudGhlbihmdW5jdGlvbihhcnJheSkge1xuICAgICAgICByZXR1cm4gUHJvbWlzZSRfUmFjZShhcnJheSwgcHJvbWlzZSk7XG4gICAgfSk7XG59O1xuXG52YXIgaGFzT3duID0ge30uaGFzT3duUHJvcGVydHk7XG5mdW5jdGlvbiBQcm9taXNlJF9SYWNlKHByb21pc2VzLCBwYXJlbnQpIHtcbiAgICB2YXIgbWF5YmVQcm9taXNlID0gY2FzdChwcm9taXNlcywgdm9pZCAwKTtcblxuICAgIGlmIChtYXliZVByb21pc2UgaW5zdGFuY2VvZiBQcm9taXNlKSB7XG4gICAgICAgIHJldHVybiByYWNlTGF0ZXIobWF5YmVQcm9taXNlKTtcbiAgICB9IGVsc2UgaWYgKCFpc0FycmF5KHByb21pc2VzKSkge1xuICAgICAgICByZXR1cm4gYXBpUmVqZWN0aW9uKFwiZXhwZWN0aW5nIGFuIGFycmF5LCBhIHByb21pc2Ugb3IgYSB0aGVuYWJsZVwiKTtcbiAgICB9XG5cbiAgICB2YXIgcmV0ID0gbmV3IFByb21pc2UoSU5URVJOQUwpO1xuICAgIGlmIChwYXJlbnQgIT09IHZvaWQgMCkge1xuICAgICAgICByZXQuX3Byb3BhZ2F0ZUZyb20ocGFyZW50LCA3KTtcbiAgICB9IGVsc2Uge1xuICAgICAgICByZXQuX3NldFRyYWNlKHZvaWQgMCk7XG4gICAgfVxuICAgIHZhciBmdWxmaWxsID0gcmV0Ll9mdWxmaWxsO1xuICAgIHZhciByZWplY3QgPSByZXQuX3JlamVjdDtcbiAgICBmb3IgKHZhciBpID0gMCwgbGVuID0gcHJvbWlzZXMubGVuZ3RoOyBpIDwgbGVuOyArK2kpIHtcbiAgICAgICAgdmFyIHZhbCA9IHByb21pc2VzW2ldO1xuXG4gICAgICAgIGlmICh2YWwgPT09IHZvaWQgMCAmJiAhKGhhc093bi5jYWxsKHByb21pc2VzLCBpKSkpIHtcbiAgICAgICAgICAgIGNvbnRpbnVlO1xuICAgICAgICB9XG5cbiAgICAgICAgUHJvbWlzZS5jYXN0KHZhbCkuX3RoZW4oZnVsZmlsbCwgcmVqZWN0LCB2b2lkIDAsIHJldCwgbnVsbCk7XG4gICAgfVxuICAgIHJldHVybiByZXQ7XG59XG5cblByb21pc2UucmFjZSA9IGZ1bmN0aW9uIFByb21pc2UkUmFjZShwcm9taXNlcykge1xuICAgIHJldHVybiBQcm9taXNlJF9SYWNlKHByb21pc2VzLCB2b2lkIDApO1xufTtcblxuUHJvbWlzZS5wcm90b3R5cGUucmFjZSA9IGZ1bmN0aW9uIFByb21pc2UkcmFjZSgpIHtcbiAgICByZXR1cm4gUHJvbWlzZSRfUmFjZSh0aGlzLCB2b2lkIDApO1xufTtcblxufTtcbiIsIi8qKlxuICogVGhlIE1JVCBMaWNlbnNlIChNSVQpXG4gKiBcbiAqIENvcHlyaWdodCAoYykgMjAxNCBQZXRrYSBBbnRvbm92XG4gKiBcbiAqIFBlcm1pc3Npb24gaXMgaGVyZWJ5IGdyYW50ZWQsIGZyZWUgb2YgY2hhcmdlLCB0byBhbnkgcGVyc29uIG9idGFpbmluZyBhIGNvcHlcbiAqIG9mIHRoaXMgc29mdHdhcmUgYW5kIGFzc29jaWF0ZWQgZG9jdW1lbnRhdGlvbiBmaWxlcyAodGhlIFwiU29mdHdhcmVcIiksIHRvIGRlYWxcbiAqIGluIHRoZSBTb2Z0d2FyZSB3aXRob3V0IHJlc3RyaWN0aW9uLCBpbmNsdWRpbmcgd2l0aG91dCBsaW1pdGF0aW9uIHRoZSByaWdodHNcbiAqIHRvIHVzZSwgY29weSwgbW9kaWZ5LCBtZXJnZSwgcHVibGlzaCwgZGlzdHJpYnV0ZSwgc3VibGljZW5zZSwgYW5kL29yIHNlbGxcbiAqIGNvcGllcyBvZiB0aGUgU29mdHdhcmUsIGFuZCB0byBwZXJtaXQgcGVyc29ucyB0byB3aG9tIHRoZSBTb2Z0d2FyZSBpc1xuICogZnVybmlzaGVkIHRvIGRvIHNvLCBzdWJqZWN0IHRvIHRoZSBmb2xsb3dpbmcgY29uZGl0aW9uczo8L3A+XG4gKiBcbiAqIFRoZSBhYm92ZSBjb3B5cmlnaHQgbm90aWNlIGFuZCB0aGlzIHBlcm1pc3Npb24gbm90aWNlIHNoYWxsIGJlIGluY2x1ZGVkIGluXG4gKiBhbGwgY29waWVzIG9yIHN1YnN0YW50aWFsIHBvcnRpb25zIG9mIHRoZSBTb2Z0d2FyZS5cbiAqIFxuICogVEhFIFNPRlRXQVJFIElTIFBST1ZJREVEIFwiQVMgSVNcIiwgV0lUSE9VVCBXQVJSQU5UWSBPRiBBTlkgS0lORCwgRVhQUkVTUyBPUlxuICogSU1QTElFRCwgSU5DTFVESU5HIEJVVCBOT1QgTElNSVRFRCBUTyBUSEUgV0FSUkFOVElFUyBPRiBNRVJDSEFOVEFCSUxJVFksXG4gKiBGSVRORVNTIEZPUiBBIFBBUlRJQ1VMQVIgUFVSUE9TRSBBTkQgTk9OSU5GUklOR0VNRU5ULiAgSU4gTk8gRVZFTlQgU0hBTEwgVEhFXG4gKiBBVVRIT1JTIE9SIENPUFlSSUdIVCBIT0xERVJTIEJFIExJQUJMRSBGT1IgQU5ZIENMQUlNLCBEQU1BR0VTIE9SIE9USEVSXG4gKiBMSUFCSUxJVFksIFdIRVRIRVIgSU4gQU4gQUNUSU9OIE9GIENPTlRSQUNULCBUT1JUIE9SIE9USEVSV0lTRSwgQVJJU0lORyBGUk9NLFxuICogT1VUIE9GIE9SIElOIENPTk5FQ1RJT04gV0lUSCBUSEUgU09GVFdBUkUgT1IgVEhFIFVTRSBPUiBPVEhFUiBERUFMSU5HUyBJTlxuICogVEhFIFNPRlRXQVJFLlxuICogXG4gKi9cblwidXNlIHN0cmljdFwiO1xubW9kdWxlLmV4cG9ydHMgPSBmdW5jdGlvbihQcm9taXNlLCBQcm9taXNlQXJyYXksIGFwaVJlamVjdGlvbiwgY2FzdCwgSU5URVJOQUwpIHtcbnZhciB1dGlsID0gcmVxdWlyZShcIi4vdXRpbC5qc1wiKTtcbnZhciB0cnlDYXRjaDQgPSB1dGlsLnRyeUNhdGNoNDtcbnZhciB0cnlDYXRjaDMgPSB1dGlsLnRyeUNhdGNoMztcbnZhciBlcnJvck9iaiA9IHV0aWwuZXJyb3JPYmo7XG5mdW5jdGlvbiBSZWR1Y3Rpb25Qcm9taXNlQXJyYXkocHJvbWlzZXMsIGZuLCBhY2N1bSwgX2VhY2gpIHtcbiAgICB0aGlzLmNvbnN0cnVjdG9yJChwcm9taXNlcyk7XG4gICAgdGhpcy5fcHJlc2VydmVkVmFsdWVzID0gX2VhY2ggPT09IElOVEVSTkFMID8gW10gOiBudWxsO1xuICAgIHRoaXMuX3plcm90aElzQWNjdW0gPSAoYWNjdW0gPT09IHZvaWQgMCk7XG4gICAgdGhpcy5fZ290QWNjdW0gPSBmYWxzZTtcbiAgICB0aGlzLl9yZWR1Y2luZ0luZGV4ID0gKHRoaXMuX3plcm90aElzQWNjdW0gPyAxIDogMCk7XG4gICAgdGhpcy5fdmFsdWVzUGhhc2UgPSB1bmRlZmluZWQ7XG5cbiAgICB2YXIgbWF5YmVQcm9taXNlID0gY2FzdChhY2N1bSwgdm9pZCAwKTtcbiAgICB2YXIgcmVqZWN0ZWQgPSBmYWxzZTtcbiAgICB2YXIgaXNQcm9taXNlID0gbWF5YmVQcm9taXNlIGluc3RhbmNlb2YgUHJvbWlzZTtcbiAgICBpZiAoaXNQcm9taXNlKSB7XG4gICAgICAgIGlmIChtYXliZVByb21pc2UuaXNQZW5kaW5nKCkpIHtcbiAgICAgICAgICAgIG1heWJlUHJvbWlzZS5fcHJveHlQcm9taXNlQXJyYXkodGhpcywgLTEpO1xuICAgICAgICB9IGVsc2UgaWYgKG1heWJlUHJvbWlzZS5pc0Z1bGZpbGxlZCgpKSB7XG4gICAgICAgICAgICBhY2N1bSA9IG1heWJlUHJvbWlzZS52YWx1ZSgpO1xuICAgICAgICAgICAgdGhpcy5fZ290QWNjdW0gPSB0cnVlO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgbWF5YmVQcm9taXNlLl91bnNldFJlamVjdGlvbklzVW5oYW5kbGVkKCk7XG4gICAgICAgICAgICB0aGlzLl9yZWplY3QobWF5YmVQcm9taXNlLnJlYXNvbigpKTtcbiAgICAgICAgICAgIHJlamVjdGVkID0gdHJ1ZTtcbiAgICAgICAgfVxuICAgIH1cbiAgICBpZiAoIShpc1Byb21pc2UgfHwgdGhpcy5femVyb3RoSXNBY2N1bSkpIHRoaXMuX2dvdEFjY3VtID0gdHJ1ZTtcbiAgICB0aGlzLl9jYWxsYmFjayA9IGZuO1xuICAgIHRoaXMuX2FjY3VtID0gYWNjdW07XG4gICAgaWYgKCFyZWplY3RlZCkgdGhpcy5faW5pdCQodm9pZCAwLCAtNSk7XG59XG51dGlsLmluaGVyaXRzKFJlZHVjdGlvblByb21pc2VBcnJheSwgUHJvbWlzZUFycmF5KTtcblxuUmVkdWN0aW9uUHJvbWlzZUFycmF5LnByb3RvdHlwZS5faW5pdCA9XG5mdW5jdGlvbiBSZWR1Y3Rpb25Qcm9taXNlQXJyYXkkX2luaXQoKSB7fTtcblxuUmVkdWN0aW9uUHJvbWlzZUFycmF5LnByb3RvdHlwZS5fcmVzb2x2ZUVtcHR5QXJyYXkgPVxuZnVuY3Rpb24gUmVkdWN0aW9uUHJvbWlzZUFycmF5JF9yZXNvbHZlRW1wdHlBcnJheSgpIHtcbiAgICBpZiAodGhpcy5fZ290QWNjdW0gfHwgdGhpcy5femVyb3RoSXNBY2N1bSkge1xuICAgICAgICB0aGlzLl9yZXNvbHZlKHRoaXMuX3ByZXNlcnZlZFZhbHVlcyAhPT0gbnVsbFxuICAgICAgICAgICAgICAgICAgICAgICAgPyBbXSA6IHRoaXMuX2FjY3VtKTtcbiAgICB9XG59O1xuXG5SZWR1Y3Rpb25Qcm9taXNlQXJyYXkucHJvdG90eXBlLl9wcm9taXNlRnVsZmlsbGVkID1cbmZ1bmN0aW9uIFJlZHVjdGlvblByb21pc2VBcnJheSRfcHJvbWlzZUZ1bGZpbGxlZCh2YWx1ZSwgaW5kZXgpIHtcbiAgICB2YXIgdmFsdWVzID0gdGhpcy5fdmFsdWVzO1xuICAgIGlmICh2YWx1ZXMgPT09IG51bGwpIHJldHVybjtcbiAgICB2YXIgbGVuZ3RoID0gdGhpcy5sZW5ndGgoKTtcbiAgICB2YXIgcHJlc2VydmVkVmFsdWVzID0gdGhpcy5fcHJlc2VydmVkVmFsdWVzO1xuICAgIHZhciBpc0VhY2ggPSBwcmVzZXJ2ZWRWYWx1ZXMgIT09IG51bGw7XG4gICAgdmFyIGdvdEFjY3VtID0gdGhpcy5fZ290QWNjdW07XG4gICAgdmFyIHZhbHVlc1BoYXNlID0gdGhpcy5fdmFsdWVzUGhhc2U7XG4gICAgdmFyIHZhbHVlc1BoYXNlSW5kZXg7XG4gICAgaWYgKCF2YWx1ZXNQaGFzZSkge1xuICAgICAgICB2YWx1ZXNQaGFzZSA9IHRoaXMuX3ZhbHVlc1BoYXNlID0gQXJyYXkobGVuZ3RoKTtcbiAgICAgICAgZm9yICh2YWx1ZXNQaGFzZUluZGV4PTA7IHZhbHVlc1BoYXNlSW5kZXg8bGVuZ3RoOyArK3ZhbHVlc1BoYXNlSW5kZXgpIHtcbiAgICAgICAgICAgIHZhbHVlc1BoYXNlW3ZhbHVlc1BoYXNlSW5kZXhdID0gMDtcbiAgICAgICAgfVxuICAgIH1cbiAgICB2YWx1ZXNQaGFzZUluZGV4ID0gdmFsdWVzUGhhc2VbaW5kZXhdO1xuXG4gICAgaWYgKGluZGV4ID09PSAwICYmIHRoaXMuX3plcm90aElzQWNjdW0pIHtcbiAgICAgICAgaWYgKCFnb3RBY2N1bSkge1xuICAgICAgICAgICAgdGhpcy5fYWNjdW0gPSB2YWx1ZTtcbiAgICAgICAgICAgIHRoaXMuX2dvdEFjY3VtID0gZ290QWNjdW0gPSB0cnVlO1xuICAgICAgICB9XG4gICAgICAgIHZhbHVlc1BoYXNlW2luZGV4XSA9ICgodmFsdWVzUGhhc2VJbmRleCA9PT0gMClcbiAgICAgICAgICAgID8gMSA6IDIpO1xuICAgIH0gZWxzZSBpZiAoaW5kZXggPT09IC0xKSB7XG4gICAgICAgIGlmICghZ290QWNjdW0pIHtcbiAgICAgICAgICAgIHRoaXMuX2FjY3VtID0gdmFsdWU7XG4gICAgICAgICAgICB0aGlzLl9nb3RBY2N1bSA9IGdvdEFjY3VtID0gdHJ1ZTtcbiAgICAgICAgfVxuICAgIH0gZWxzZSB7XG4gICAgICAgIGlmICh2YWx1ZXNQaGFzZUluZGV4ID09PSAwKSB7XG4gICAgICAgICAgICB2YWx1ZXNQaGFzZVtpbmRleF0gPSAxO1xuICAgICAgICB9XG4gICAgICAgIGVsc2Uge1xuICAgICAgICAgICAgdmFsdWVzUGhhc2VbaW5kZXhdID0gMjtcbiAgICAgICAgICAgIGlmIChnb3RBY2N1bSkge1xuICAgICAgICAgICAgICAgIHRoaXMuX2FjY3VtID0gdmFsdWU7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICB9XG4gICAgaWYgKCFnb3RBY2N1bSkgcmV0dXJuO1xuXG4gICAgdmFyIGNhbGxiYWNrID0gdGhpcy5fY2FsbGJhY2s7XG4gICAgdmFyIHJlY2VpdmVyID0gdGhpcy5fcHJvbWlzZS5fYm91bmRUbztcbiAgICB2YXIgcmV0O1xuXG4gICAgZm9yICh2YXIgaSA9IHRoaXMuX3JlZHVjaW5nSW5kZXg7IGkgPCBsZW5ndGg7ICsraSkge1xuICAgICAgICB2YWx1ZXNQaGFzZUluZGV4ID0gdmFsdWVzUGhhc2VbaV07XG4gICAgICAgIGlmICh2YWx1ZXNQaGFzZUluZGV4ID09PSAyKSB7XG4gICAgICAgICAgICB0aGlzLl9yZWR1Y2luZ0luZGV4ID0gaSArIDE7XG4gICAgICAgICAgICBjb250aW51ZTtcbiAgICAgICAgfVxuICAgICAgICBpZiAodmFsdWVzUGhhc2VJbmRleCAhPT0gMSkgcmV0dXJuO1xuXG4gICAgICAgIHZhbHVlID0gdmFsdWVzW2ldO1xuICAgICAgICBpZiAodmFsdWUgaW5zdGFuY2VvZiBQcm9taXNlKSB7XG4gICAgICAgICAgICBpZiAodmFsdWUuaXNGdWxmaWxsZWQoKSkge1xuICAgICAgICAgICAgICAgIHZhbHVlID0gdmFsdWUuX3NldHRsZWRWYWx1ZTtcbiAgICAgICAgICAgIH0gZWxzZSBpZiAodmFsdWUuaXNQZW5kaW5nKCkpIHtcbiAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHZhbHVlLl91bnNldFJlamVjdGlvbklzVW5oYW5kbGVkKCk7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX3JlamVjdCh2YWx1ZS5yZWFzb24oKSk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoaXNFYWNoKSB7XG4gICAgICAgICAgICBwcmVzZXJ2ZWRWYWx1ZXMucHVzaCh2YWx1ZSk7XG4gICAgICAgICAgICByZXQgPSB0cnlDYXRjaDMoY2FsbGJhY2ssIHJlY2VpdmVyLCB2YWx1ZSwgaSwgbGVuZ3RoKTtcbiAgICAgICAgfVxuICAgICAgICBlbHNlIHtcbiAgICAgICAgICAgIHJldCA9IHRyeUNhdGNoNChjYWxsYmFjaywgcmVjZWl2ZXIsIHRoaXMuX2FjY3VtLCB2YWx1ZSwgaSwgbGVuZ3RoKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChyZXQgPT09IGVycm9yT2JqKSByZXR1cm4gdGhpcy5fcmVqZWN0KHJldC5lKTtcblxuICAgICAgICB2YXIgbWF5YmVQcm9taXNlID0gY2FzdChyZXQsIHZvaWQgMCk7XG4gICAgICAgIGlmIChtYXliZVByb21pc2UgaW5zdGFuY2VvZiBQcm9taXNlKSB7XG4gICAgICAgICAgICBpZiAobWF5YmVQcm9taXNlLmlzUGVuZGluZygpKSB7XG4gICAgICAgICAgICAgICAgdmFsdWVzUGhhc2VbaV0gPSA0O1xuICAgICAgICAgICAgICAgIHJldHVybiBtYXliZVByb21pc2UuX3Byb3h5UHJvbWlzZUFycmF5KHRoaXMsIGkpO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChtYXliZVByb21pc2UuaXNGdWxmaWxsZWQoKSkge1xuICAgICAgICAgICAgICAgIHJldCA9IG1heWJlUHJvbWlzZS52YWx1ZSgpO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBtYXliZVByb21pc2UuX3Vuc2V0UmVqZWN0aW9uSXNVbmhhbmRsZWQoKTtcbiAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fcmVqZWN0KG1heWJlUHJvbWlzZS5yZWFzb24oKSk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICB0aGlzLl9yZWR1Y2luZ0luZGV4ID0gaSArIDE7XG4gICAgICAgIHRoaXMuX2FjY3VtID0gcmV0O1xuICAgIH1cblxuICAgIGlmICh0aGlzLl9yZWR1Y2luZ0luZGV4IDwgbGVuZ3RoKSByZXR1cm47XG4gICAgdGhpcy5fcmVzb2x2ZShpc0VhY2ggPyBwcmVzZXJ2ZWRWYWx1ZXMgOiB0aGlzLl9hY2N1bSk7XG59O1xuXG5mdW5jdGlvbiByZWR1Y2UocHJvbWlzZXMsIGZuLCBpbml0aWFsVmFsdWUsIF9lYWNoKSB7XG4gICAgaWYgKHR5cGVvZiBmbiAhPT0gXCJmdW5jdGlvblwiKSByZXR1cm4gYXBpUmVqZWN0aW9uKFwiZm4gbXVzdCBiZSBhIGZ1bmN0aW9uXCIpO1xuICAgIHZhciBhcnJheSA9IG5ldyBSZWR1Y3Rpb25Qcm9taXNlQXJyYXkocHJvbWlzZXMsIGZuLCBpbml0aWFsVmFsdWUsIF9lYWNoKTtcbiAgICByZXR1cm4gYXJyYXkucHJvbWlzZSgpO1xufVxuXG5Qcm9taXNlLnByb3RvdHlwZS5yZWR1Y2UgPSBmdW5jdGlvbiBQcm9taXNlJHJlZHVjZShmbiwgaW5pdGlhbFZhbHVlKSB7XG4gICAgcmV0dXJuIHJlZHVjZSh0aGlzLCBmbiwgaW5pdGlhbFZhbHVlLCBudWxsKTtcbn07XG5cblByb21pc2UucmVkdWNlID0gZnVuY3Rpb24gUHJvbWlzZSRSZWR1Y2UocHJvbWlzZXMsIGZuLCBpbml0aWFsVmFsdWUsIF9lYWNoKSB7XG4gICAgcmV0dXJuIHJlZHVjZShwcm9taXNlcywgZm4sIGluaXRpYWxWYWx1ZSwgX2VhY2gpO1xufTtcbn07XG4iLCIvKipcbiAqIFRoZSBNSVQgTGljZW5zZSAoTUlUKVxuICogXG4gKiBDb3B5cmlnaHQgKGMpIDIwMTQgUGV0a2EgQW50b25vdlxuICogXG4gKiBQZXJtaXNzaW9uIGlzIGhlcmVieSBncmFudGVkLCBmcmVlIG9mIGNoYXJnZSwgdG8gYW55IHBlcnNvbiBvYnRhaW5pbmcgYSBjb3B5XG4gKiBvZiB0aGlzIHNvZnR3YXJlIGFuZCBhc3NvY2lhdGVkIGRvY3VtZW50YXRpb24gZmlsZXMgKHRoZSBcIlNvZnR3YXJlXCIpLCB0byBkZWFsXG4gKiBpbiB0aGUgU29mdHdhcmUgd2l0aG91dCByZXN0cmljdGlvbiwgaW5jbHVkaW5nIHdpdGhvdXQgbGltaXRhdGlvbiB0aGUgcmlnaHRzXG4gKiB0byB1c2UsIGNvcHksIG1vZGlmeSwgbWVyZ2UsIHB1Ymxpc2gsIGRpc3RyaWJ1dGUsIHN1YmxpY2Vuc2UsIGFuZC9vciBzZWxsXG4gKiBjb3BpZXMgb2YgdGhlIFNvZnR3YXJlLCBhbmQgdG8gcGVybWl0IHBlcnNvbnMgdG8gd2hvbSB0aGUgU29mdHdhcmUgaXNcbiAqIGZ1cm5pc2hlZCB0byBkbyBzbywgc3ViamVjdCB0byB0aGUgZm9sbG93aW5nIGNvbmRpdGlvbnM6PC9wPlxuICogXG4gKiBUaGUgYWJvdmUgY29weXJpZ2h0IG5vdGljZSBhbmQgdGhpcyBwZXJtaXNzaW9uIG5vdGljZSBzaGFsbCBiZSBpbmNsdWRlZCBpblxuICogYWxsIGNvcGllcyBvciBzdWJzdGFudGlhbCBwb3J0aW9ucyBvZiB0aGUgU29mdHdhcmUuXG4gKiBcbiAqIFRIRSBTT0ZUV0FSRSBJUyBQUk9WSURFRCBcIkFTIElTXCIsIFdJVEhPVVQgV0FSUkFOVFkgT0YgQU5ZIEtJTkQsIEVYUFJFU1MgT1JcbiAqIElNUExJRUQsIElOQ0xVRElORyBCVVQgTk9UIExJTUlURUQgVE8gVEhFIFdBUlJBTlRJRVMgT0YgTUVSQ0hBTlRBQklMSVRZLFxuICogRklUTkVTUyBGT1IgQSBQQVJUSUNVTEFSIFBVUlBPU0UgQU5EIE5PTklORlJJTkdFTUVOVC4gIElOIE5PIEVWRU5UIFNIQUxMIFRIRVxuICogQVVUSE9SUyBPUiBDT1BZUklHSFQgSE9MREVSUyBCRSBMSUFCTEUgRk9SIEFOWSBDTEFJTSwgREFNQUdFUyBPUiBPVEhFUlxuICogTElBQklMSVRZLCBXSEVUSEVSIElOIEFOIEFDVElPTiBPRiBDT05UUkFDVCwgVE9SVCBPUiBPVEhFUldJU0UsIEFSSVNJTkcgRlJPTSxcbiAqIE9VVCBPRiBPUiBJTiBDT05ORUNUSU9OIFdJVEggVEhFIFNPRlRXQVJFIE9SIFRIRSBVU0UgT1IgT1RIRVIgREVBTElOR1MgSU5cbiAqIFRIRSBTT0ZUV0FSRS5cbiAqIFxuICovXG5cInVzZSBzdHJpY3RcIjtcbnZhciBzY2hlZHVsZTtcbnZhciBfTXV0YXRpb25PYnNlcnZlcjtcbmlmICh0eXBlb2YgcHJvY2VzcyA9PT0gXCJvYmplY3RcIiAmJiB0eXBlb2YgcHJvY2Vzcy52ZXJzaW9uID09PSBcInN0cmluZ1wiKSB7XG4gICAgc2NoZWR1bGUgPSBmdW5jdGlvbiBQcm9taXNlJF9TY2hlZHVsZXIoZm4pIHtcbiAgICAgICAgcHJvY2Vzcy5uZXh0VGljayhmbik7XG4gICAgfTtcbn1cbmVsc2UgaWYgKCh0eXBlb2YgTXV0YXRpb25PYnNlcnZlciAhPT0gXCJ1bmRlZmluZWRcIiAmJlxuICAgICAgICAgKF9NdXRhdGlvbk9ic2VydmVyID0gTXV0YXRpb25PYnNlcnZlcikpIHx8XG4gICAgICAgICAodHlwZW9mIFdlYktpdE11dGF0aW9uT2JzZXJ2ZXIgIT09IFwidW5kZWZpbmVkXCIgJiZcbiAgICAgICAgIChfTXV0YXRpb25PYnNlcnZlciA9IFdlYktpdE11dGF0aW9uT2JzZXJ2ZXIpKSkge1xuICAgIHNjaGVkdWxlID0gKGZ1bmN0aW9uKCkge1xuICAgICAgICB2YXIgZGl2ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudChcImRpdlwiKTtcbiAgICAgICAgdmFyIHF1ZXVlZEZuID0gdm9pZCAwO1xuICAgICAgICB2YXIgb2JzZXJ2ZXIgPSBuZXcgX011dGF0aW9uT2JzZXJ2ZXIoXG4gICAgICAgICAgICBmdW5jdGlvbiBQcm9taXNlJF9TY2hlZHVsZXIoKSB7XG4gICAgICAgICAgICAgICAgdmFyIGZuID0gcXVldWVkRm47XG4gICAgICAgICAgICAgICAgcXVldWVkRm4gPSB2b2lkIDA7XG4gICAgICAgICAgICAgICAgZm4oKTtcbiAgICAgICAgICAgIH1cbiAgICAgICApO1xuICAgICAgICBvYnNlcnZlci5vYnNlcnZlKGRpdiwge1xuICAgICAgICAgICAgYXR0cmlidXRlczogdHJ1ZVxuICAgICAgICB9KTtcbiAgICAgICAgcmV0dXJuIGZ1bmN0aW9uIFByb21pc2UkX1NjaGVkdWxlcihmbikge1xuICAgICAgICAgICAgcXVldWVkRm4gPSBmbjtcbiAgICAgICAgICAgIGRpdi5jbGFzc0xpc3QudG9nZ2xlKFwiZm9vXCIpO1xuICAgICAgICB9O1xuXG4gICAgfSkoKTtcbn1cbmVsc2UgaWYgKHR5cGVvZiBzZXRUaW1lb3V0ICE9PSBcInVuZGVmaW5lZFwiKSB7XG4gICAgc2NoZWR1bGUgPSBmdW5jdGlvbiBQcm9taXNlJF9TY2hlZHVsZXIoZm4pIHtcbiAgICAgICAgc2V0VGltZW91dChmbiwgMCk7XG4gICAgfTtcbn1cbmVsc2UgdGhyb3cgbmV3IEVycm9yKFwibm8gYXN5bmMgc2NoZWR1bGVyIGF2YWlsYWJsZVwiKTtcbm1vZHVsZS5leHBvcnRzID0gc2NoZWR1bGU7XG4iLCIvKipcbiAqIFRoZSBNSVQgTGljZW5zZSAoTUlUKVxuICogXG4gKiBDb3B5cmlnaHQgKGMpIDIwMTQgUGV0a2EgQW50b25vdlxuICogXG4gKiBQZXJtaXNzaW9uIGlzIGhlcmVieSBncmFudGVkLCBmcmVlIG9mIGNoYXJnZSwgdG8gYW55IHBlcnNvbiBvYnRhaW5pbmcgYSBjb3B5XG4gKiBvZiB0aGlzIHNvZnR3YXJlIGFuZCBhc3NvY2lhdGVkIGRvY3VtZW50YXRpb24gZmlsZXMgKHRoZSBcIlNvZnR3YXJlXCIpLCB0byBkZWFsXG4gKiBpbiB0aGUgU29mdHdhcmUgd2l0aG91dCByZXN0cmljdGlvbiwgaW5jbHVkaW5nIHdpdGhvdXQgbGltaXRhdGlvbiB0aGUgcmlnaHRzXG4gKiB0byB1c2UsIGNvcHksIG1vZGlmeSwgbWVyZ2UsIHB1Ymxpc2gsIGRpc3RyaWJ1dGUsIHN1YmxpY2Vuc2UsIGFuZC9vciBzZWxsXG4gKiBjb3BpZXMgb2YgdGhlIFNvZnR3YXJlLCBhbmQgdG8gcGVybWl0IHBlcnNvbnMgdG8gd2hvbSB0aGUgU29mdHdhcmUgaXNcbiAqIGZ1cm5pc2hlZCB0byBkbyBzbywgc3ViamVjdCB0byB0aGUgZm9sbG93aW5nIGNvbmRpdGlvbnM6PC9wPlxuICogXG4gKiBUaGUgYWJvdmUgY29weXJpZ2h0IG5vdGljZSBhbmQgdGhpcyBwZXJtaXNzaW9uIG5vdGljZSBzaGFsbCBiZSBpbmNsdWRlZCBpblxuICogYWxsIGNvcGllcyBvciBzdWJzdGFudGlhbCBwb3J0aW9ucyBvZiB0aGUgU29mdHdhcmUuXG4gKiBcbiAqIFRIRSBTT0ZUV0FSRSBJUyBQUk9WSURFRCBcIkFTIElTXCIsIFdJVEhPVVQgV0FSUkFOVFkgT0YgQU5ZIEtJTkQsIEVYUFJFU1MgT1JcbiAqIElNUExJRUQsIElOQ0xVRElORyBCVVQgTk9UIExJTUlURUQgVE8gVEhFIFdBUlJBTlRJRVMgT0YgTUVSQ0hBTlRBQklMSVRZLFxuICogRklUTkVTUyBGT1IgQSBQQVJUSUNVTEFSIFBVUlBPU0UgQU5EIE5PTklORlJJTkdFTUVOVC4gIElOIE5PIEVWRU5UIFNIQUxMIFRIRVxuICogQVVUSE9SUyBPUiBDT1BZUklHSFQgSE9MREVSUyBCRSBMSUFCTEUgRk9SIEFOWSBDTEFJTSwgREFNQUdFUyBPUiBPVEhFUlxuICogTElBQklMSVRZLCBXSEVUSEVSIElOIEFOIEFDVElPTiBPRiBDT05UUkFDVCwgVE9SVCBPUiBPVEhFUldJU0UsIEFSSVNJTkcgRlJPTSxcbiAqIE9VVCBPRiBPUiBJTiBDT05ORUNUSU9OIFdJVEggVEhFIFNPRlRXQVJFIE9SIFRIRSBVU0UgT1IgT1RIRVIgREVBTElOR1MgSU5cbiAqIFRIRSBTT0ZUV0FSRS5cbiAqIFxuICovXG5cInVzZSBzdHJpY3RcIjtcbm1vZHVsZS5leHBvcnRzID1cbiAgICBmdW5jdGlvbihQcm9taXNlLCBQcm9taXNlQXJyYXkpIHtcbnZhciBQcm9taXNlSW5zcGVjdGlvbiA9IFByb21pc2UuUHJvbWlzZUluc3BlY3Rpb247XG52YXIgdXRpbCA9IHJlcXVpcmUoXCIuL3V0aWwuanNcIik7XG5cbmZ1bmN0aW9uIFNldHRsZWRQcm9taXNlQXJyYXkodmFsdWVzKSB7XG4gICAgdGhpcy5jb25zdHJ1Y3RvciQodmFsdWVzKTtcbn1cbnV0aWwuaW5oZXJpdHMoU2V0dGxlZFByb21pc2VBcnJheSwgUHJvbWlzZUFycmF5KTtcblxuU2V0dGxlZFByb21pc2VBcnJheS5wcm90b3R5cGUuX3Byb21pc2VSZXNvbHZlZCA9XG5mdW5jdGlvbiBTZXR0bGVkUHJvbWlzZUFycmF5JF9wcm9taXNlUmVzb2x2ZWQoaW5kZXgsIGluc3BlY3Rpb24pIHtcbiAgICB0aGlzLl92YWx1ZXNbaW5kZXhdID0gaW5zcGVjdGlvbjtcbiAgICB2YXIgdG90YWxSZXNvbHZlZCA9ICsrdGhpcy5fdG90YWxSZXNvbHZlZDtcbiAgICBpZiAodG90YWxSZXNvbHZlZCA+PSB0aGlzLl9sZW5ndGgpIHtcbiAgICAgICAgdGhpcy5fcmVzb2x2ZSh0aGlzLl92YWx1ZXMpO1xuICAgIH1cbn07XG5cblNldHRsZWRQcm9taXNlQXJyYXkucHJvdG90eXBlLl9wcm9taXNlRnVsZmlsbGVkID1cbmZ1bmN0aW9uIFNldHRsZWRQcm9taXNlQXJyYXkkX3Byb21pc2VGdWxmaWxsZWQodmFsdWUsIGluZGV4KSB7XG4gICAgaWYgKHRoaXMuX2lzUmVzb2x2ZWQoKSkgcmV0dXJuO1xuICAgIHZhciByZXQgPSBuZXcgUHJvbWlzZUluc3BlY3Rpb24oKTtcbiAgICByZXQuX2JpdEZpZWxkID0gMjY4NDM1NDU2O1xuICAgIHJldC5fc2V0dGxlZFZhbHVlID0gdmFsdWU7XG4gICAgdGhpcy5fcHJvbWlzZVJlc29sdmVkKGluZGV4LCByZXQpO1xufTtcblNldHRsZWRQcm9taXNlQXJyYXkucHJvdG90eXBlLl9wcm9taXNlUmVqZWN0ZWQgPVxuZnVuY3Rpb24gU2V0dGxlZFByb21pc2VBcnJheSRfcHJvbWlzZVJlamVjdGVkKHJlYXNvbiwgaW5kZXgpIHtcbiAgICBpZiAodGhpcy5faXNSZXNvbHZlZCgpKSByZXR1cm47XG4gICAgdmFyIHJldCA9IG5ldyBQcm9taXNlSW5zcGVjdGlvbigpO1xuICAgIHJldC5fYml0RmllbGQgPSAxMzQyMTc3Mjg7XG4gICAgcmV0Ll9zZXR0bGVkVmFsdWUgPSByZWFzb247XG4gICAgdGhpcy5fcHJvbWlzZVJlc29sdmVkKGluZGV4LCByZXQpO1xufTtcblxuUHJvbWlzZS5zZXR0bGUgPSBmdW5jdGlvbiBQcm9taXNlJFNldHRsZShwcm9taXNlcykge1xuICAgIHJldHVybiBuZXcgU2V0dGxlZFByb21pc2VBcnJheShwcm9taXNlcykucHJvbWlzZSgpO1xufTtcblxuUHJvbWlzZS5wcm90b3R5cGUuc2V0dGxlID0gZnVuY3Rpb24gUHJvbWlzZSRzZXR0bGUoKSB7XG4gICAgcmV0dXJuIG5ldyBTZXR0bGVkUHJvbWlzZUFycmF5KHRoaXMpLnByb21pc2UoKTtcbn07XG59O1xuIiwiLyoqXG4gKiBUaGUgTUlUIExpY2Vuc2UgKE1JVClcbiAqIFxuICogQ29weXJpZ2h0IChjKSAyMDE0IFBldGthIEFudG9ub3ZcbiAqIFxuICogUGVybWlzc2lvbiBpcyBoZXJlYnkgZ3JhbnRlZCwgZnJlZSBvZiBjaGFyZ2UsIHRvIGFueSBwZXJzb24gb2J0YWluaW5nIGEgY29weVxuICogb2YgdGhpcyBzb2Z0d2FyZSBhbmQgYXNzb2NpYXRlZCBkb2N1bWVudGF0aW9uIGZpbGVzICh0aGUgXCJTb2Z0d2FyZVwiKSwgdG8gZGVhbFxuICogaW4gdGhlIFNvZnR3YXJlIHdpdGhvdXQgcmVzdHJpY3Rpb24sIGluY2x1ZGluZyB3aXRob3V0IGxpbWl0YXRpb24gdGhlIHJpZ2h0c1xuICogdG8gdXNlLCBjb3B5LCBtb2RpZnksIG1lcmdlLCBwdWJsaXNoLCBkaXN0cmlidXRlLCBzdWJsaWNlbnNlLCBhbmQvb3Igc2VsbFxuICogY29waWVzIG9mIHRoZSBTb2Z0d2FyZSwgYW5kIHRvIHBlcm1pdCBwZXJzb25zIHRvIHdob20gdGhlIFNvZnR3YXJlIGlzXG4gKiBmdXJuaXNoZWQgdG8gZG8gc28sIHN1YmplY3QgdG8gdGhlIGZvbGxvd2luZyBjb25kaXRpb25zOjwvcD5cbiAqIFxuICogVGhlIGFib3ZlIGNvcHlyaWdodCBub3RpY2UgYW5kIHRoaXMgcGVybWlzc2lvbiBub3RpY2Ugc2hhbGwgYmUgaW5jbHVkZWQgaW5cbiAqIGFsbCBjb3BpZXMgb3Igc3Vic3RhbnRpYWwgcG9ydGlvbnMgb2YgdGhlIFNvZnR3YXJlLlxuICogXG4gKiBUSEUgU09GVFdBUkUgSVMgUFJPVklERUQgXCJBUyBJU1wiLCBXSVRIT1VUIFdBUlJBTlRZIE9GIEFOWSBLSU5ELCBFWFBSRVNTIE9SXG4gKiBJTVBMSUVELCBJTkNMVURJTkcgQlVUIE5PVCBMSU1JVEVEIFRPIFRIRSBXQVJSQU5USUVTIE9GIE1FUkNIQU5UQUJJTElUWSxcbiAqIEZJVE5FU1MgRk9SIEEgUEFSVElDVUxBUiBQVVJQT1NFIEFORCBOT05JTkZSSU5HRU1FTlQuICBJTiBOTyBFVkVOVCBTSEFMTCBUSEVcbiAqIEFVVEhPUlMgT1IgQ09QWVJJR0hUIEhPTERFUlMgQkUgTElBQkxFIEZPUiBBTlkgQ0xBSU0sIERBTUFHRVMgT1IgT1RIRVJcbiAqIExJQUJJTElUWSwgV0hFVEhFUiBJTiBBTiBBQ1RJT04gT0YgQ09OVFJBQ1QsIFRPUlQgT1IgT1RIRVJXSVNFLCBBUklTSU5HIEZST00sXG4gKiBPVVQgT0YgT1IgSU4gQ09OTkVDVElPTiBXSVRIIFRIRSBTT0ZUV0FSRSBPUiBUSEUgVVNFIE9SIE9USEVSIERFQUxJTkdTIElOXG4gKiBUSEUgU09GVFdBUkUuXG4gKiBcbiAqL1xuXCJ1c2Ugc3RyaWN0XCI7XG5tb2R1bGUuZXhwb3J0cyA9XG5mdW5jdGlvbihQcm9taXNlLCBQcm9taXNlQXJyYXksIGFwaVJlamVjdGlvbikge1xudmFyIHV0aWwgPSByZXF1aXJlKFwiLi91dGlsLmpzXCIpO1xudmFyIFJhbmdlRXJyb3IgPSByZXF1aXJlKFwiLi9lcnJvcnMuanNcIikuUmFuZ2VFcnJvcjtcbnZhciBBZ2dyZWdhdGVFcnJvciA9IHJlcXVpcmUoXCIuL2Vycm9ycy5qc1wiKS5BZ2dyZWdhdGVFcnJvcjtcbnZhciBpc0FycmF5ID0gdXRpbC5pc0FycmF5O1xuXG5cbmZ1bmN0aW9uIFNvbWVQcm9taXNlQXJyYXkodmFsdWVzKSB7XG4gICAgdGhpcy5jb25zdHJ1Y3RvciQodmFsdWVzKTtcbiAgICB0aGlzLl9ob3dNYW55ID0gMDtcbiAgICB0aGlzLl91bndyYXAgPSBmYWxzZTtcbiAgICB0aGlzLl9pbml0aWFsaXplZCA9IGZhbHNlO1xufVxudXRpbC5pbmhlcml0cyhTb21lUHJvbWlzZUFycmF5LCBQcm9taXNlQXJyYXkpO1xuXG5Tb21lUHJvbWlzZUFycmF5LnByb3RvdHlwZS5faW5pdCA9IGZ1bmN0aW9uIFNvbWVQcm9taXNlQXJyYXkkX2luaXQoKSB7XG4gICAgaWYgKCF0aGlzLl9pbml0aWFsaXplZCkge1xuICAgICAgICByZXR1cm47XG4gICAgfVxuICAgIGlmICh0aGlzLl9ob3dNYW55ID09PSAwKSB7XG4gICAgICAgIHRoaXMuX3Jlc29sdmUoW10pO1xuICAgICAgICByZXR1cm47XG4gICAgfVxuICAgIHRoaXMuX2luaXQkKHZvaWQgMCwgLTUpO1xuICAgIHZhciBpc0FycmF5UmVzb2x2ZWQgPSBpc0FycmF5KHRoaXMuX3ZhbHVlcyk7XG4gICAgaWYgKCF0aGlzLl9pc1Jlc29sdmVkKCkgJiZcbiAgICAgICAgaXNBcnJheVJlc29sdmVkICYmXG4gICAgICAgIHRoaXMuX2hvd01hbnkgPiB0aGlzLl9jYW5Qb3NzaWJseUZ1bGZpbGwoKSkge1xuICAgICAgICB0aGlzLl9yZWplY3QodGhpcy5fZ2V0UmFuZ2VFcnJvcih0aGlzLmxlbmd0aCgpKSk7XG4gICAgfVxufTtcblxuU29tZVByb21pc2VBcnJheS5wcm90b3R5cGUuaW5pdCA9IGZ1bmN0aW9uIFNvbWVQcm9taXNlQXJyYXkkaW5pdCgpIHtcbiAgICB0aGlzLl9pbml0aWFsaXplZCA9IHRydWU7XG4gICAgdGhpcy5faW5pdCgpO1xufTtcblxuU29tZVByb21pc2VBcnJheS5wcm90b3R5cGUuc2V0VW53cmFwID0gZnVuY3Rpb24gU29tZVByb21pc2VBcnJheSRzZXRVbndyYXAoKSB7XG4gICAgdGhpcy5fdW53cmFwID0gdHJ1ZTtcbn07XG5cblNvbWVQcm9taXNlQXJyYXkucHJvdG90eXBlLmhvd01hbnkgPSBmdW5jdGlvbiBTb21lUHJvbWlzZUFycmF5JGhvd01hbnkoKSB7XG4gICAgcmV0dXJuIHRoaXMuX2hvd01hbnk7XG59O1xuXG5Tb21lUHJvbWlzZUFycmF5LnByb3RvdHlwZS5zZXRIb3dNYW55ID1cbmZ1bmN0aW9uIFNvbWVQcm9taXNlQXJyYXkkc2V0SG93TWFueShjb3VudCkge1xuICAgIGlmICh0aGlzLl9pc1Jlc29sdmVkKCkpIHJldHVybjtcbiAgICB0aGlzLl9ob3dNYW55ID0gY291bnQ7XG59O1xuXG5Tb21lUHJvbWlzZUFycmF5LnByb3RvdHlwZS5fcHJvbWlzZUZ1bGZpbGxlZCA9XG5mdW5jdGlvbiBTb21lUHJvbWlzZUFycmF5JF9wcm9taXNlRnVsZmlsbGVkKHZhbHVlKSB7XG4gICAgaWYgKHRoaXMuX2lzUmVzb2x2ZWQoKSkgcmV0dXJuO1xuICAgIHRoaXMuX2FkZEZ1bGZpbGxlZCh2YWx1ZSk7XG4gICAgaWYgKHRoaXMuX2Z1bGZpbGxlZCgpID09PSB0aGlzLmhvd01hbnkoKSkge1xuICAgICAgICB0aGlzLl92YWx1ZXMubGVuZ3RoID0gdGhpcy5ob3dNYW55KCk7XG4gICAgICAgIGlmICh0aGlzLmhvd01hbnkoKSA9PT0gMSAmJiB0aGlzLl91bndyYXApIHtcbiAgICAgICAgICAgIHRoaXMuX3Jlc29sdmUodGhpcy5fdmFsdWVzWzBdKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHRoaXMuX3Jlc29sdmUodGhpcy5fdmFsdWVzKTtcbiAgICAgICAgfVxuICAgIH1cblxufTtcblNvbWVQcm9taXNlQXJyYXkucHJvdG90eXBlLl9wcm9taXNlUmVqZWN0ZWQgPVxuZnVuY3Rpb24gU29tZVByb21pc2VBcnJheSRfcHJvbWlzZVJlamVjdGVkKHJlYXNvbikge1xuICAgIGlmICh0aGlzLl9pc1Jlc29sdmVkKCkpIHJldHVybjtcbiAgICB0aGlzLl9hZGRSZWplY3RlZChyZWFzb24pO1xuICAgIGlmICh0aGlzLmhvd01hbnkoKSA+IHRoaXMuX2NhblBvc3NpYmx5RnVsZmlsbCgpKSB7XG4gICAgICAgIHZhciBlID0gbmV3IEFnZ3JlZ2F0ZUVycm9yKCk7XG4gICAgICAgIGZvciAodmFyIGkgPSB0aGlzLmxlbmd0aCgpOyBpIDwgdGhpcy5fdmFsdWVzLmxlbmd0aDsgKytpKSB7XG4gICAgICAgICAgICBlLnB1c2godGhpcy5fdmFsdWVzW2ldKTtcbiAgICAgICAgfVxuICAgICAgICB0aGlzLl9yZWplY3QoZSk7XG4gICAgfVxufTtcblxuU29tZVByb21pc2VBcnJheS5wcm90b3R5cGUuX2Z1bGZpbGxlZCA9IGZ1bmN0aW9uIFNvbWVQcm9taXNlQXJyYXkkX2Z1bGZpbGxlZCgpIHtcbiAgICByZXR1cm4gdGhpcy5fdG90YWxSZXNvbHZlZDtcbn07XG5cblNvbWVQcm9taXNlQXJyYXkucHJvdG90eXBlLl9yZWplY3RlZCA9IGZ1bmN0aW9uIFNvbWVQcm9taXNlQXJyYXkkX3JlamVjdGVkKCkge1xuICAgIHJldHVybiB0aGlzLl92YWx1ZXMubGVuZ3RoIC0gdGhpcy5sZW5ndGgoKTtcbn07XG5cblNvbWVQcm9taXNlQXJyYXkucHJvdG90eXBlLl9hZGRSZWplY3RlZCA9XG5mdW5jdGlvbiBTb21lUHJvbWlzZUFycmF5JF9hZGRSZWplY3RlZChyZWFzb24pIHtcbiAgICB0aGlzLl92YWx1ZXMucHVzaChyZWFzb24pO1xufTtcblxuU29tZVByb21pc2VBcnJheS5wcm90b3R5cGUuX2FkZEZ1bGZpbGxlZCA9XG5mdW5jdGlvbiBTb21lUHJvbWlzZUFycmF5JF9hZGRGdWxmaWxsZWQodmFsdWUpIHtcbiAgICB0aGlzLl92YWx1ZXNbdGhpcy5fdG90YWxSZXNvbHZlZCsrXSA9IHZhbHVlO1xufTtcblxuU29tZVByb21pc2VBcnJheS5wcm90b3R5cGUuX2NhblBvc3NpYmx5RnVsZmlsbCA9XG5mdW5jdGlvbiBTb21lUHJvbWlzZUFycmF5JF9jYW5Qb3NzaWJseUZ1bGZpbGwoKSB7XG4gICAgcmV0dXJuIHRoaXMubGVuZ3RoKCkgLSB0aGlzLl9yZWplY3RlZCgpO1xufTtcblxuU29tZVByb21pc2VBcnJheS5wcm90b3R5cGUuX2dldFJhbmdlRXJyb3IgPVxuZnVuY3Rpb24gU29tZVByb21pc2VBcnJheSRfZ2V0UmFuZ2VFcnJvcihjb3VudCkge1xuICAgIHZhciBtZXNzYWdlID0gXCJJbnB1dCBhcnJheSBtdXN0IGNvbnRhaW4gYXQgbGVhc3QgXCIgK1xuICAgICAgICAgICAgdGhpcy5faG93TWFueSArIFwiIGl0ZW1zIGJ1dCBjb250YWlucyBvbmx5IFwiICsgY291bnQgKyBcIiBpdGVtc1wiO1xuICAgIHJldHVybiBuZXcgUmFuZ2VFcnJvcihtZXNzYWdlKTtcbn07XG5cblNvbWVQcm9taXNlQXJyYXkucHJvdG90eXBlLl9yZXNvbHZlRW1wdHlBcnJheSA9XG5mdW5jdGlvbiBTb21lUHJvbWlzZUFycmF5JF9yZXNvbHZlRW1wdHlBcnJheSgpIHtcbiAgICB0aGlzLl9yZWplY3QodGhpcy5fZ2V0UmFuZ2VFcnJvcigwKSk7XG59O1xuXG5mdW5jdGlvbiBQcm9taXNlJF9Tb21lKHByb21pc2VzLCBob3dNYW55KSB7XG4gICAgaWYgKChob3dNYW55IHwgMCkgIT09IGhvd01hbnkgfHwgaG93TWFueSA8IDApIHtcbiAgICAgICAgcmV0dXJuIGFwaVJlamVjdGlvbihcImV4cGVjdGluZyBhIHBvc2l0aXZlIGludGVnZXJcIik7XG4gICAgfVxuICAgIHZhciByZXQgPSBuZXcgU29tZVByb21pc2VBcnJheShwcm9taXNlcyk7XG4gICAgdmFyIHByb21pc2UgPSByZXQucHJvbWlzZSgpO1xuICAgIGlmIChwcm9taXNlLmlzUmVqZWN0ZWQoKSkge1xuICAgICAgICByZXR1cm4gcHJvbWlzZTtcbiAgICB9XG4gICAgcmV0LnNldEhvd01hbnkoaG93TWFueSk7XG4gICAgcmV0LmluaXQoKTtcbiAgICByZXR1cm4gcHJvbWlzZTtcbn1cblxuUHJvbWlzZS5zb21lID0gZnVuY3Rpb24gUHJvbWlzZSRTb21lKHByb21pc2VzLCBob3dNYW55KSB7XG4gICAgcmV0dXJuIFByb21pc2UkX1NvbWUocHJvbWlzZXMsIGhvd01hbnkpO1xufTtcblxuUHJvbWlzZS5wcm90b3R5cGUuc29tZSA9IGZ1bmN0aW9uIFByb21pc2Ukc29tZShob3dNYW55KSB7XG4gICAgcmV0dXJuIFByb21pc2UkX1NvbWUodGhpcywgaG93TWFueSk7XG59O1xuXG5Qcm9taXNlLl9Tb21lUHJvbWlzZUFycmF5ID0gU29tZVByb21pc2VBcnJheTtcbn07XG4iLCIvKipcbiAqIFRoZSBNSVQgTGljZW5zZSAoTUlUKVxuICogXG4gKiBDb3B5cmlnaHQgKGMpIDIwMTQgUGV0a2EgQW50b25vdlxuICogXG4gKiBQZXJtaXNzaW9uIGlzIGhlcmVieSBncmFudGVkLCBmcmVlIG9mIGNoYXJnZSwgdG8gYW55IHBlcnNvbiBvYnRhaW5pbmcgYSBjb3B5XG4gKiBvZiB0aGlzIHNvZnR3YXJlIGFuZCBhc3NvY2lhdGVkIGRvY3VtZW50YXRpb24gZmlsZXMgKHRoZSBcIlNvZnR3YXJlXCIpLCB0byBkZWFsXG4gKiBpbiB0aGUgU29mdHdhcmUgd2l0aG91dCByZXN0cmljdGlvbiwgaW5jbHVkaW5nIHdpdGhvdXQgbGltaXRhdGlvbiB0aGUgcmlnaHRzXG4gKiB0byB1c2UsIGNvcHksIG1vZGlmeSwgbWVyZ2UsIHB1Ymxpc2gsIGRpc3RyaWJ1dGUsIHN1YmxpY2Vuc2UsIGFuZC9vciBzZWxsXG4gKiBjb3BpZXMgb2YgdGhlIFNvZnR3YXJlLCBhbmQgdG8gcGVybWl0IHBlcnNvbnMgdG8gd2hvbSB0aGUgU29mdHdhcmUgaXNcbiAqIGZ1cm5pc2hlZCB0byBkbyBzbywgc3ViamVjdCB0byB0aGUgZm9sbG93aW5nIGNvbmRpdGlvbnM6PC9wPlxuICogXG4gKiBUaGUgYWJvdmUgY29weXJpZ2h0IG5vdGljZSBhbmQgdGhpcyBwZXJtaXNzaW9uIG5vdGljZSBzaGFsbCBiZSBpbmNsdWRlZCBpblxuICogYWxsIGNvcGllcyBvciBzdWJzdGFudGlhbCBwb3J0aW9ucyBvZiB0aGUgU29mdHdhcmUuXG4gKiBcbiAqIFRIRSBTT0ZUV0FSRSBJUyBQUk9WSURFRCBcIkFTIElTXCIsIFdJVEhPVVQgV0FSUkFOVFkgT0YgQU5ZIEtJTkQsIEVYUFJFU1MgT1JcbiAqIElNUExJRUQsIElOQ0xVRElORyBCVVQgTk9UIExJTUlURUQgVE8gVEhFIFdBUlJBTlRJRVMgT0YgTUVSQ0hBTlRBQklMSVRZLFxuICogRklUTkVTUyBGT1IgQSBQQVJUSUNVTEFSIFBVUlBPU0UgQU5EIE5PTklORlJJTkdFTUVOVC4gIElOIE5PIEVWRU5UIFNIQUxMIFRIRVxuICogQVVUSE9SUyBPUiBDT1BZUklHSFQgSE9MREVSUyBCRSBMSUFCTEUgRk9SIEFOWSBDTEFJTSwgREFNQUdFUyBPUiBPVEhFUlxuICogTElBQklMSVRZLCBXSEVUSEVSIElOIEFOIEFDVElPTiBPRiBDT05UUkFDVCwgVE9SVCBPUiBPVEhFUldJU0UsIEFSSVNJTkcgRlJPTSxcbiAqIE9VVCBPRiBPUiBJTiBDT05ORUNUSU9OIFdJVEggVEhFIFNPRlRXQVJFIE9SIFRIRSBVU0UgT1IgT1RIRVIgREVBTElOR1MgSU5cbiAqIFRIRSBTT0ZUV0FSRS5cbiAqIFxuICovXG5cInVzZSBzdHJpY3RcIjtcbm1vZHVsZS5leHBvcnRzID0gZnVuY3Rpb24oUHJvbWlzZSkge1xuZnVuY3Rpb24gUHJvbWlzZUluc3BlY3Rpb24ocHJvbWlzZSkge1xuICAgIGlmIChwcm9taXNlICE9PSB2b2lkIDApIHtcbiAgICAgICAgdGhpcy5fYml0RmllbGQgPSBwcm9taXNlLl9iaXRGaWVsZDtcbiAgICAgICAgdGhpcy5fc2V0dGxlZFZhbHVlID0gcHJvbWlzZS5pc1Jlc29sdmVkKClcbiAgICAgICAgICAgID8gcHJvbWlzZS5fc2V0dGxlZFZhbHVlXG4gICAgICAgICAgICA6IHZvaWQgMDtcbiAgICB9XG4gICAgZWxzZSB7XG4gICAgICAgIHRoaXMuX2JpdEZpZWxkID0gMDtcbiAgICAgICAgdGhpcy5fc2V0dGxlZFZhbHVlID0gdm9pZCAwO1xuICAgIH1cbn1cblxuUHJvbWlzZUluc3BlY3Rpb24ucHJvdG90eXBlLmlzRnVsZmlsbGVkID1cblByb21pc2UucHJvdG90eXBlLmlzRnVsZmlsbGVkID0gZnVuY3Rpb24gUHJvbWlzZSRpc0Z1bGZpbGxlZCgpIHtcbiAgICByZXR1cm4gKHRoaXMuX2JpdEZpZWxkICYgMjY4NDM1NDU2KSA+IDA7XG59O1xuXG5Qcm9taXNlSW5zcGVjdGlvbi5wcm90b3R5cGUuaXNSZWplY3RlZCA9XG5Qcm9taXNlLnByb3RvdHlwZS5pc1JlamVjdGVkID0gZnVuY3Rpb24gUHJvbWlzZSRpc1JlamVjdGVkKCkge1xuICAgIHJldHVybiAodGhpcy5fYml0RmllbGQgJiAxMzQyMTc3MjgpID4gMDtcbn07XG5cblByb21pc2VJbnNwZWN0aW9uLnByb3RvdHlwZS5pc1BlbmRpbmcgPVxuUHJvbWlzZS5wcm90b3R5cGUuaXNQZW5kaW5nID0gZnVuY3Rpb24gUHJvbWlzZSRpc1BlbmRpbmcoKSB7XG4gICAgcmV0dXJuICh0aGlzLl9iaXRGaWVsZCAmIDQwMjY1MzE4NCkgPT09IDA7XG59O1xuXG5Qcm9taXNlSW5zcGVjdGlvbi5wcm90b3R5cGUudmFsdWUgPVxuUHJvbWlzZS5wcm90b3R5cGUudmFsdWUgPSBmdW5jdGlvbiBQcm9taXNlJHZhbHVlKCkge1xuICAgIGlmICghdGhpcy5pc0Z1bGZpbGxlZCgpKSB7XG4gICAgICAgIHRocm93IG5ldyBUeXBlRXJyb3IoXCJjYW5ub3QgZ2V0IGZ1bGZpbGxtZW50IHZhbHVlIG9mIGEgbm9uLWZ1bGZpbGxlZCBwcm9taXNlXCIpO1xuICAgIH1cbiAgICByZXR1cm4gdGhpcy5fc2V0dGxlZFZhbHVlO1xufTtcblxuUHJvbWlzZUluc3BlY3Rpb24ucHJvdG90eXBlLmVycm9yID1cblByb21pc2VJbnNwZWN0aW9uLnByb3RvdHlwZS5yZWFzb24gPVxuUHJvbWlzZS5wcm90b3R5cGUucmVhc29uID0gZnVuY3Rpb24gUHJvbWlzZSRyZWFzb24oKSB7XG4gICAgaWYgKCF0aGlzLmlzUmVqZWN0ZWQoKSkge1xuICAgICAgICB0aHJvdyBuZXcgVHlwZUVycm9yKFwiY2Fubm90IGdldCByZWplY3Rpb24gcmVhc29uIG9mIGEgbm9uLXJlamVjdGVkIHByb21pc2VcIik7XG4gICAgfVxuICAgIHJldHVybiB0aGlzLl9zZXR0bGVkVmFsdWU7XG59O1xuXG5Qcm9taXNlSW5zcGVjdGlvbi5wcm90b3R5cGUuaXNSZXNvbHZlZCA9XG5Qcm9taXNlLnByb3RvdHlwZS5pc1Jlc29sdmVkID0gZnVuY3Rpb24gUHJvbWlzZSRpc1Jlc29sdmVkKCkge1xuICAgIHJldHVybiAodGhpcy5fYml0RmllbGQgJiA0MDI2NTMxODQpID4gMDtcbn07XG5cblByb21pc2UuUHJvbWlzZUluc3BlY3Rpb24gPSBQcm9taXNlSW5zcGVjdGlvbjtcbn07XG4iLCIvKipcbiAqIFRoZSBNSVQgTGljZW5zZSAoTUlUKVxuICogXG4gKiBDb3B5cmlnaHQgKGMpIDIwMTQgUGV0a2EgQW50b25vdlxuICogXG4gKiBQZXJtaXNzaW9uIGlzIGhlcmVieSBncmFudGVkLCBmcmVlIG9mIGNoYXJnZSwgdG8gYW55IHBlcnNvbiBvYnRhaW5pbmcgYSBjb3B5XG4gKiBvZiB0aGlzIHNvZnR3YXJlIGFuZCBhc3NvY2lhdGVkIGRvY3VtZW50YXRpb24gZmlsZXMgKHRoZSBcIlNvZnR3YXJlXCIpLCB0byBkZWFsXG4gKiBpbiB0aGUgU29mdHdhcmUgd2l0aG91dCByZXN0cmljdGlvbiwgaW5jbHVkaW5nIHdpdGhvdXQgbGltaXRhdGlvbiB0aGUgcmlnaHRzXG4gKiB0byB1c2UsIGNvcHksIG1vZGlmeSwgbWVyZ2UsIHB1Ymxpc2gsIGRpc3RyaWJ1dGUsIHN1YmxpY2Vuc2UsIGFuZC9vciBzZWxsXG4gKiBjb3BpZXMgb2YgdGhlIFNvZnR3YXJlLCBhbmQgdG8gcGVybWl0IHBlcnNvbnMgdG8gd2hvbSB0aGUgU29mdHdhcmUgaXNcbiAqIGZ1cm5pc2hlZCB0byBkbyBzbywgc3ViamVjdCB0byB0aGUgZm9sbG93aW5nIGNvbmRpdGlvbnM6PC9wPlxuICogXG4gKiBUaGUgYWJvdmUgY29weXJpZ2h0IG5vdGljZSBhbmQgdGhpcyBwZXJtaXNzaW9uIG5vdGljZSBzaGFsbCBiZSBpbmNsdWRlZCBpblxuICogYWxsIGNvcGllcyBvciBzdWJzdGFudGlhbCBwb3J0aW9ucyBvZiB0aGUgU29mdHdhcmUuXG4gKiBcbiAqIFRIRSBTT0ZUV0FSRSBJUyBQUk9WSURFRCBcIkFTIElTXCIsIFdJVEhPVVQgV0FSUkFOVFkgT0YgQU5ZIEtJTkQsIEVYUFJFU1MgT1JcbiAqIElNUExJRUQsIElOQ0xVRElORyBCVVQgTk9UIExJTUlURUQgVE8gVEhFIFdBUlJBTlRJRVMgT0YgTUVSQ0hBTlRBQklMSVRZLFxuICogRklUTkVTUyBGT1IgQSBQQVJUSUNVTEFSIFBVUlBPU0UgQU5EIE5PTklORlJJTkdFTUVOVC4gIElOIE5PIEVWRU5UIFNIQUxMIFRIRVxuICogQVVUSE9SUyBPUiBDT1BZUklHSFQgSE9MREVSUyBCRSBMSUFCTEUgRk9SIEFOWSBDTEFJTSwgREFNQUdFUyBPUiBPVEhFUlxuICogTElBQklMSVRZLCBXSEVUSEVSIElOIEFOIEFDVElPTiBPRiBDT05UUkFDVCwgVE9SVCBPUiBPVEhFUldJU0UsIEFSSVNJTkcgRlJPTSxcbiAqIE9VVCBPRiBPUiBJTiBDT05ORUNUSU9OIFdJVEggVEhFIFNPRlRXQVJFIE9SIFRIRSBVU0UgT1IgT1RIRVIgREVBTElOR1MgSU5cbiAqIFRIRSBTT0ZUV0FSRS5cbiAqIFxuICovXG5cInVzZSBzdHJpY3RcIjtcbm1vZHVsZS5leHBvcnRzID0gZnVuY3Rpb24oUHJvbWlzZSwgSU5URVJOQUwpIHtcbnZhciB1dGlsID0gcmVxdWlyZShcIi4vdXRpbC5qc1wiKTtcbnZhciBjYW5BdHRhY2ggPSByZXF1aXJlKFwiLi9lcnJvcnMuanNcIikuY2FuQXR0YWNoO1xudmFyIGVycm9yT2JqID0gdXRpbC5lcnJvck9iajtcbnZhciBpc09iamVjdCA9IHV0aWwuaXNPYmplY3Q7XG5cbmZ1bmN0aW9uIGdldFRoZW4ob2JqKSB7XG4gICAgdHJ5IHtcbiAgICAgICAgcmV0dXJuIG9iai50aGVuO1xuICAgIH1cbiAgICBjYXRjaChlKSB7XG4gICAgICAgIGVycm9yT2JqLmUgPSBlO1xuICAgICAgICByZXR1cm4gZXJyb3JPYmo7XG4gICAgfVxufVxuXG5mdW5jdGlvbiBQcm9taXNlJF9DYXN0KG9iaiwgb3JpZ2luYWxQcm9taXNlKSB7XG4gICAgaWYgKGlzT2JqZWN0KG9iaikpIHtcbiAgICAgICAgaWYgKG9iaiBpbnN0YW5jZW9mIFByb21pc2UpIHtcbiAgICAgICAgICAgIHJldHVybiBvYmo7XG4gICAgICAgIH1cbiAgICAgICAgZWxzZSBpZiAoaXNBbnlCbHVlYmlyZFByb21pc2Uob2JqKSkge1xuICAgICAgICAgICAgdmFyIHJldCA9IG5ldyBQcm9taXNlKElOVEVSTkFMKTtcbiAgICAgICAgICAgIHJldC5fc2V0VHJhY2Uodm9pZCAwKTtcbiAgICAgICAgICAgIG9iai5fdGhlbihcbiAgICAgICAgICAgICAgICByZXQuX2Z1bGZpbGxVbmNoZWNrZWQsXG4gICAgICAgICAgICAgICAgcmV0Ll9yZWplY3RVbmNoZWNrZWRDaGVja0Vycm9yLFxuICAgICAgICAgICAgICAgIHJldC5fcHJvZ3Jlc3NVbmNoZWNrZWQsXG4gICAgICAgICAgICAgICAgcmV0LFxuICAgICAgICAgICAgICAgIG51bGxcbiAgICAgICAgICAgICk7XG4gICAgICAgICAgICByZXQuX3NldEZvbGxvd2luZygpO1xuICAgICAgICAgICAgcmV0dXJuIHJldDtcbiAgICAgICAgfVxuICAgICAgICB2YXIgdGhlbiA9IGdldFRoZW4ob2JqKTtcbiAgICAgICAgaWYgKHRoZW4gPT09IGVycm9yT2JqKSB7XG4gICAgICAgICAgICBpZiAob3JpZ2luYWxQcm9taXNlICE9PSB2b2lkIDAgJiYgY2FuQXR0YWNoKHRoZW4uZSkpIHtcbiAgICAgICAgICAgICAgICBvcmlnaW5hbFByb21pc2UuX2F0dGFjaEV4dHJhVHJhY2UodGhlbi5lKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHJldHVybiBQcm9taXNlLnJlamVjdCh0aGVuLmUpO1xuICAgICAgICB9IGVsc2UgaWYgKHR5cGVvZiB0aGVuID09PSBcImZ1bmN0aW9uXCIpIHtcbiAgICAgICAgICAgIHJldHVybiBQcm9taXNlJF9kb1RoZW5hYmxlKG9iaiwgdGhlbiwgb3JpZ2luYWxQcm9taXNlKTtcbiAgICAgICAgfVxuICAgIH1cbiAgICByZXR1cm4gb2JqO1xufVxuXG52YXIgaGFzUHJvcCA9IHt9Lmhhc093blByb3BlcnR5O1xuZnVuY3Rpb24gaXNBbnlCbHVlYmlyZFByb21pc2Uob2JqKSB7XG4gICAgcmV0dXJuIGhhc1Byb3AuY2FsbChvYmosIFwiX3Byb21pc2UwXCIpO1xufVxuXG5mdW5jdGlvbiBQcm9taXNlJF9kb1RoZW5hYmxlKHgsIHRoZW4sIG9yaWdpbmFsUHJvbWlzZSkge1xuICAgIHZhciByZXNvbHZlciA9IFByb21pc2UuZGVmZXIoKTtcbiAgICB2YXIgY2FsbGVkID0gZmFsc2U7XG4gICAgdHJ5IHtcbiAgICAgICAgdGhlbi5jYWxsKFxuICAgICAgICAgICAgeCxcbiAgICAgICAgICAgIFByb21pc2UkX3Jlc29sdmVGcm9tVGhlbmFibGUsXG4gICAgICAgICAgICBQcm9taXNlJF9yZWplY3RGcm9tVGhlbmFibGUsXG4gICAgICAgICAgICBQcm9taXNlJF9wcm9ncmVzc0Zyb21UaGVuYWJsZVxuICAgICAgICApO1xuICAgIH0gY2F0Y2goZSkge1xuICAgICAgICBpZiAoIWNhbGxlZCkge1xuICAgICAgICAgICAgY2FsbGVkID0gdHJ1ZTtcbiAgICAgICAgICAgIHZhciB0cmFjZSA9IGNhbkF0dGFjaChlKSA/IGUgOiBuZXcgRXJyb3IoZSArIFwiXCIpO1xuICAgICAgICAgICAgaWYgKG9yaWdpbmFsUHJvbWlzZSAhPT0gdm9pZCAwKSB7XG4gICAgICAgICAgICAgICAgb3JpZ2luYWxQcm9taXNlLl9hdHRhY2hFeHRyYVRyYWNlKHRyYWNlKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHJlc29sdmVyLnByb21pc2UuX3JlamVjdChlLCB0cmFjZSk7XG4gICAgICAgIH1cbiAgICB9XG4gICAgcmV0dXJuIHJlc29sdmVyLnByb21pc2U7XG5cbiAgICBmdW5jdGlvbiBQcm9taXNlJF9yZXNvbHZlRnJvbVRoZW5hYmxlKHkpIHtcbiAgICAgICAgaWYgKGNhbGxlZCkgcmV0dXJuO1xuICAgICAgICBjYWxsZWQgPSB0cnVlO1xuXG4gICAgICAgIGlmICh4ID09PSB5KSB7XG4gICAgICAgICAgICB2YXIgZSA9IFByb21pc2UuX21ha2VTZWxmUmVzb2x1dGlvbkVycm9yKCk7XG4gICAgICAgICAgICBpZiAob3JpZ2luYWxQcm9taXNlICE9PSB2b2lkIDApIHtcbiAgICAgICAgICAgICAgICBvcmlnaW5hbFByb21pc2UuX2F0dGFjaEV4dHJhVHJhY2UoZSk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICByZXNvbHZlci5wcm9taXNlLl9yZWplY3QoZSwgdm9pZCAwKTtcbiAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuICAgICAgICByZXNvbHZlci5yZXNvbHZlKHkpO1xuICAgIH1cblxuICAgIGZ1bmN0aW9uIFByb21pc2UkX3JlamVjdEZyb21UaGVuYWJsZShyKSB7XG4gICAgICAgIGlmIChjYWxsZWQpIHJldHVybjtcbiAgICAgICAgY2FsbGVkID0gdHJ1ZTtcbiAgICAgICAgdmFyIHRyYWNlID0gY2FuQXR0YWNoKHIpID8gciA6IG5ldyBFcnJvcihyICsgXCJcIik7XG4gICAgICAgIGlmIChvcmlnaW5hbFByb21pc2UgIT09IHZvaWQgMCkge1xuICAgICAgICAgICAgb3JpZ2luYWxQcm9taXNlLl9hdHRhY2hFeHRyYVRyYWNlKHRyYWNlKTtcbiAgICAgICAgfVxuICAgICAgICByZXNvbHZlci5wcm9taXNlLl9yZWplY3QociwgdHJhY2UpO1xuICAgIH1cblxuICAgIGZ1bmN0aW9uIFByb21pc2UkX3Byb2dyZXNzRnJvbVRoZW5hYmxlKHYpIHtcbiAgICAgICAgaWYgKGNhbGxlZCkgcmV0dXJuO1xuICAgICAgICB2YXIgcHJvbWlzZSA9IHJlc29sdmVyLnByb21pc2U7XG4gICAgICAgIGlmICh0eXBlb2YgcHJvbWlzZS5fcHJvZ3Jlc3MgPT09IFwiZnVuY3Rpb25cIikge1xuICAgICAgICAgICAgcHJvbWlzZS5fcHJvZ3Jlc3Modik7XG4gICAgICAgIH1cbiAgICB9XG59XG5cbnJldHVybiBQcm9taXNlJF9DYXN0O1xufTtcbiIsIi8qKlxuICogVGhlIE1JVCBMaWNlbnNlIChNSVQpXG4gKiBcbiAqIENvcHlyaWdodCAoYykgMjAxNCBQZXRrYSBBbnRvbm92XG4gKiBcbiAqIFBlcm1pc3Npb24gaXMgaGVyZWJ5IGdyYW50ZWQsIGZyZWUgb2YgY2hhcmdlLCB0byBhbnkgcGVyc29uIG9idGFpbmluZyBhIGNvcHlcbiAqIG9mIHRoaXMgc29mdHdhcmUgYW5kIGFzc29jaWF0ZWQgZG9jdW1lbnRhdGlvbiBmaWxlcyAodGhlIFwiU29mdHdhcmVcIiksIHRvIGRlYWxcbiAqIGluIHRoZSBTb2Z0d2FyZSB3aXRob3V0IHJlc3RyaWN0aW9uLCBpbmNsdWRpbmcgd2l0aG91dCBsaW1pdGF0aW9uIHRoZSByaWdodHNcbiAqIHRvIHVzZSwgY29weSwgbW9kaWZ5LCBtZXJnZSwgcHVibGlzaCwgZGlzdHJpYnV0ZSwgc3VibGljZW5zZSwgYW5kL29yIHNlbGxcbiAqIGNvcGllcyBvZiB0aGUgU29mdHdhcmUsIGFuZCB0byBwZXJtaXQgcGVyc29ucyB0byB3aG9tIHRoZSBTb2Z0d2FyZSBpc1xuICogZnVybmlzaGVkIHRvIGRvIHNvLCBzdWJqZWN0IHRvIHRoZSBmb2xsb3dpbmcgY29uZGl0aW9uczo8L3A+XG4gKiBcbiAqIFRoZSBhYm92ZSBjb3B5cmlnaHQgbm90aWNlIGFuZCB0aGlzIHBlcm1pc3Npb24gbm90aWNlIHNoYWxsIGJlIGluY2x1ZGVkIGluXG4gKiBhbGwgY29waWVzIG9yIHN1YnN0YW50aWFsIHBvcnRpb25zIG9mIHRoZSBTb2Z0d2FyZS5cbiAqIFxuICogVEhFIFNPRlRXQVJFIElTIFBST1ZJREVEIFwiQVMgSVNcIiwgV0lUSE9VVCBXQVJSQU5UWSBPRiBBTlkgS0lORCwgRVhQUkVTUyBPUlxuICogSU1QTElFRCwgSU5DTFVESU5HIEJVVCBOT1QgTElNSVRFRCBUTyBUSEUgV0FSUkFOVElFUyBPRiBNRVJDSEFOVEFCSUxJVFksXG4gKiBGSVRORVNTIEZPUiBBIFBBUlRJQ1VMQVIgUFVSUE9TRSBBTkQgTk9OSU5GUklOR0VNRU5ULiAgSU4gTk8gRVZFTlQgU0hBTEwgVEhFXG4gKiBBVVRIT1JTIE9SIENPUFlSSUdIVCBIT0xERVJTIEJFIExJQUJMRSBGT1IgQU5ZIENMQUlNLCBEQU1BR0VTIE9SIE9USEVSXG4gKiBMSUFCSUxJVFksIFdIRVRIRVIgSU4gQU4gQUNUSU9OIE9GIENPTlRSQUNULCBUT1JUIE9SIE9USEVSV0lTRSwgQVJJU0lORyBGUk9NLFxuICogT1VUIE9GIE9SIElOIENPTk5FQ1RJT04gV0lUSCBUSEUgU09GVFdBUkUgT1IgVEhFIFVTRSBPUiBPVEhFUiBERUFMSU5HUyBJTlxuICogVEhFIFNPRlRXQVJFLlxuICogXG4gKi9cblwidXNlIHN0cmljdFwiO1xudmFyIF9zZXRUaW1lb3V0ID0gZnVuY3Rpb24oZm4sIG1zKSB7XG4gICAgdmFyIGxlbiA9IGFyZ3VtZW50cy5sZW5ndGg7XG4gICAgdmFyIGFyZzAgPSBhcmd1bWVudHNbMl07XG4gICAgdmFyIGFyZzEgPSBhcmd1bWVudHNbM107XG4gICAgdmFyIGFyZzIgPSBsZW4gPj0gNSA/IGFyZ3VtZW50c1s0XSA6IHZvaWQgMDtcbiAgICByZXR1cm4gc2V0VGltZW91dChmdW5jdGlvbigpIHtcbiAgICAgICAgZm4oYXJnMCwgYXJnMSwgYXJnMik7XG4gICAgfSwgbXN8MCk7XG59O1xuXG5tb2R1bGUuZXhwb3J0cyA9IGZ1bmN0aW9uKFByb21pc2UsIElOVEVSTkFMLCBjYXN0KSB7XG52YXIgdXRpbCA9IHJlcXVpcmUoXCIuL3V0aWwuanNcIik7XG52YXIgZXJyb3JzID0gcmVxdWlyZShcIi4vZXJyb3JzLmpzXCIpO1xudmFyIGFwaVJlamVjdGlvbiA9IHJlcXVpcmUoXCIuL2Vycm9yc19hcGlfcmVqZWN0aW9uXCIpKFByb21pc2UpO1xudmFyIFRpbWVvdXRFcnJvciA9IFByb21pc2UuVGltZW91dEVycm9yO1xuXG52YXIgYWZ0ZXJUaW1lb3V0ID0gZnVuY3Rpb24gUHJvbWlzZSRfYWZ0ZXJUaW1lb3V0KHByb21pc2UsIG1lc3NhZ2UsIG1zKSB7XG4gICAgaWYgKCFwcm9taXNlLmlzUGVuZGluZygpKSByZXR1cm47XG4gICAgaWYgKHR5cGVvZiBtZXNzYWdlICE9PSBcInN0cmluZ1wiKSB7XG4gICAgICAgIG1lc3NhZ2UgPSBcIm9wZXJhdGlvbiB0aW1lZCBvdXQgYWZ0ZXJcIiArIFwiIFwiICsgbXMgKyBcIiBtc1wiXG4gICAgfVxuICAgIHZhciBlcnIgPSBuZXcgVGltZW91dEVycm9yKG1lc3NhZ2UpO1xuICAgIGVycm9ycy5tYXJrQXNPcmlnaW5hdGluZ0Zyb21SZWplY3Rpb24oZXJyKTtcbiAgICBwcm9taXNlLl9hdHRhY2hFeHRyYVRyYWNlKGVycik7XG4gICAgcHJvbWlzZS5fY2FuY2VsKGVycik7XG59O1xuXG52YXIgYWZ0ZXJEZWxheSA9IGZ1bmN0aW9uIFByb21pc2UkX2FmdGVyRGVsYXkodmFsdWUsIHByb21pc2UpIHtcbiAgICBwcm9taXNlLl9mdWxmaWxsKHZhbHVlKTtcbn07XG5cbnZhciBkZWxheSA9IFByb21pc2UuZGVsYXkgPSBmdW5jdGlvbiBQcm9taXNlJERlbGF5KHZhbHVlLCBtcykge1xuICAgIGlmIChtcyA9PT0gdm9pZCAwKSB7XG4gICAgICAgIG1zID0gdmFsdWU7XG4gICAgICAgIHZhbHVlID0gdm9pZCAwO1xuICAgIH1cbiAgICBtcyA9ICttcztcbiAgICB2YXIgbWF5YmVQcm9taXNlID0gY2FzdCh2YWx1ZSwgdm9pZCAwKTtcbiAgICB2YXIgcHJvbWlzZSA9IG5ldyBQcm9taXNlKElOVEVSTkFMKTtcblxuICAgIGlmIChtYXliZVByb21pc2UgaW5zdGFuY2VvZiBQcm9taXNlKSB7XG4gICAgICAgIHByb21pc2UuX3Byb3BhZ2F0ZUZyb20obWF5YmVQcm9taXNlLCA3KTtcbiAgICAgICAgcHJvbWlzZS5fZm9sbG93KG1heWJlUHJvbWlzZSk7XG4gICAgICAgIHJldHVybiBwcm9taXNlLnRoZW4oZnVuY3Rpb24odmFsdWUpIHtcbiAgICAgICAgICAgIHJldHVybiBQcm9taXNlLmRlbGF5KHZhbHVlLCBtcyk7XG4gICAgICAgIH0pO1xuICAgIH0gZWxzZSB7XG4gICAgICAgIHByb21pc2UuX3NldFRyYWNlKHZvaWQgMCk7XG4gICAgICAgIF9zZXRUaW1lb3V0KGFmdGVyRGVsYXksIG1zLCB2YWx1ZSwgcHJvbWlzZSk7XG4gICAgfVxuICAgIHJldHVybiBwcm9taXNlO1xufTtcblxuUHJvbWlzZS5wcm90b3R5cGUuZGVsYXkgPSBmdW5jdGlvbiBQcm9taXNlJGRlbGF5KG1zKSB7XG4gICAgcmV0dXJuIGRlbGF5KHRoaXMsIG1zKTtcbn07XG5cbmZ1bmN0aW9uIHN1Y2Nlc3NDbGVhcih2YWx1ZSkge1xuICAgIHZhciBoYW5kbGUgPSB0aGlzO1xuICAgIGlmIChoYW5kbGUgaW5zdGFuY2VvZiBOdW1iZXIpIGhhbmRsZSA9ICtoYW5kbGU7XG4gICAgY2xlYXJUaW1lb3V0KGhhbmRsZSk7XG4gICAgcmV0dXJuIHZhbHVlO1xufVxuXG5mdW5jdGlvbiBmYWlsdXJlQ2xlYXIocmVhc29uKSB7XG4gICAgdmFyIGhhbmRsZSA9IHRoaXM7XG4gICAgaWYgKGhhbmRsZSBpbnN0YW5jZW9mIE51bWJlcikgaGFuZGxlID0gK2hhbmRsZTtcbiAgICBjbGVhclRpbWVvdXQoaGFuZGxlKTtcbiAgICB0aHJvdyByZWFzb247XG59XG5cblByb21pc2UucHJvdG90eXBlLnRpbWVvdXQgPSBmdW5jdGlvbiBQcm9taXNlJHRpbWVvdXQobXMsIG1lc3NhZ2UpIHtcbiAgICBtcyA9ICttcztcblxuICAgIHZhciByZXQgPSBuZXcgUHJvbWlzZShJTlRFUk5BTCk7XG4gICAgcmV0Ll9wcm9wYWdhdGVGcm9tKHRoaXMsIDcpO1xuICAgIHJldC5fZm9sbG93KHRoaXMpO1xuICAgIHZhciBoYW5kbGUgPSBfc2V0VGltZW91dChhZnRlclRpbWVvdXQsIG1zLCByZXQsIG1lc3NhZ2UsIG1zKTtcbiAgICByZXR1cm4gcmV0LmNhbmNlbGxhYmxlKClcbiAgICAgICAgICAgICAgLl90aGVuKHN1Y2Nlc3NDbGVhciwgZmFpbHVyZUNsZWFyLCB2b2lkIDAsIGhhbmRsZSwgdm9pZCAwKTtcbn07XG5cbn07XG4iLCIvKipcbiAqIFRoZSBNSVQgTGljZW5zZSAoTUlUKVxuICogXG4gKiBDb3B5cmlnaHQgKGMpIDIwMTQgUGV0a2EgQW50b25vdlxuICogXG4gKiBQZXJtaXNzaW9uIGlzIGhlcmVieSBncmFudGVkLCBmcmVlIG9mIGNoYXJnZSwgdG8gYW55IHBlcnNvbiBvYnRhaW5pbmcgYSBjb3B5XG4gKiBvZiB0aGlzIHNvZnR3YXJlIGFuZCBhc3NvY2lhdGVkIGRvY3VtZW50YXRpb24gZmlsZXMgKHRoZSBcIlNvZnR3YXJlXCIpLCB0byBkZWFsXG4gKiBpbiB0aGUgU29mdHdhcmUgd2l0aG91dCByZXN0cmljdGlvbiwgaW5jbHVkaW5nIHdpdGhvdXQgbGltaXRhdGlvbiB0aGUgcmlnaHRzXG4gKiB0byB1c2UsIGNvcHksIG1vZGlmeSwgbWVyZ2UsIHB1Ymxpc2gsIGRpc3RyaWJ1dGUsIHN1YmxpY2Vuc2UsIGFuZC9vciBzZWxsXG4gKiBjb3BpZXMgb2YgdGhlIFNvZnR3YXJlLCBhbmQgdG8gcGVybWl0IHBlcnNvbnMgdG8gd2hvbSB0aGUgU29mdHdhcmUgaXNcbiAqIGZ1cm5pc2hlZCB0byBkbyBzbywgc3ViamVjdCB0byB0aGUgZm9sbG93aW5nIGNvbmRpdGlvbnM6PC9wPlxuICogXG4gKiBUaGUgYWJvdmUgY29weXJpZ2h0IG5vdGljZSBhbmQgdGhpcyBwZXJtaXNzaW9uIG5vdGljZSBzaGFsbCBiZSBpbmNsdWRlZCBpblxuICogYWxsIGNvcGllcyBvciBzdWJzdGFudGlhbCBwb3J0aW9ucyBvZiB0aGUgU29mdHdhcmUuXG4gKiBcbiAqIFRIRSBTT0ZUV0FSRSBJUyBQUk9WSURFRCBcIkFTIElTXCIsIFdJVEhPVVQgV0FSUkFOVFkgT0YgQU5ZIEtJTkQsIEVYUFJFU1MgT1JcbiAqIElNUExJRUQsIElOQ0xVRElORyBCVVQgTk9UIExJTUlURUQgVE8gVEhFIFdBUlJBTlRJRVMgT0YgTUVSQ0hBTlRBQklMSVRZLFxuICogRklUTkVTUyBGT1IgQSBQQVJUSUNVTEFSIFBVUlBPU0UgQU5EIE5PTklORlJJTkdFTUVOVC4gIElOIE5PIEVWRU5UIFNIQUxMIFRIRVxuICogQVVUSE9SUyBPUiBDT1BZUklHSFQgSE9MREVSUyBCRSBMSUFCTEUgRk9SIEFOWSBDTEFJTSwgREFNQUdFUyBPUiBPVEhFUlxuICogTElBQklMSVRZLCBXSEVUSEVSIElOIEFOIEFDVElPTiBPRiBDT05UUkFDVCwgVE9SVCBPUiBPVEhFUldJU0UsIEFSSVNJTkcgRlJPTSxcbiAqIE9VVCBPRiBPUiBJTiBDT05ORUNUSU9OIFdJVEggVEhFIFNPRlRXQVJFIE9SIFRIRSBVU0UgT1IgT1RIRVIgREVBTElOR1MgSU5cbiAqIFRIRSBTT0ZUV0FSRS5cbiAqIFxuICovXG5cInVzZSBzdHJpY3RcIjtcbm1vZHVsZS5leHBvcnRzID0gZnVuY3Rpb24gKFByb21pc2UsIGFwaVJlamVjdGlvbiwgY2FzdCkge1xuICAgIHZhciBUeXBlRXJyb3IgPSByZXF1aXJlKFwiLi9lcnJvcnMuanNcIikuVHlwZUVycm9yO1xuICAgIHZhciBpbmhlcml0cyA9IHJlcXVpcmUoXCIuL3V0aWwuanNcIikuaW5oZXJpdHM7XG4gICAgdmFyIFByb21pc2VJbnNwZWN0aW9uID0gUHJvbWlzZS5Qcm9taXNlSW5zcGVjdGlvbjtcblxuICAgIGZ1bmN0aW9uIGluc3BlY3Rpb25NYXBwZXIoaW5zcGVjdGlvbnMpIHtcbiAgICAgICAgdmFyIGxlbiA9IGluc3BlY3Rpb25zLmxlbmd0aDtcbiAgICAgICAgZm9yICh2YXIgaSA9IDA7IGkgPCBsZW47ICsraSkge1xuICAgICAgICAgICAgdmFyIGluc3BlY3Rpb24gPSBpbnNwZWN0aW9uc1tpXTtcbiAgICAgICAgICAgIGlmIChpbnNwZWN0aW9uLmlzUmVqZWN0ZWQoKSkge1xuICAgICAgICAgICAgICAgIHJldHVybiBQcm9taXNlLnJlamVjdChpbnNwZWN0aW9uLmVycm9yKCkpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgaW5zcGVjdGlvbnNbaV0gPSBpbnNwZWN0aW9uLnZhbHVlKCk7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIGluc3BlY3Rpb25zO1xuICAgIH1cblxuICAgIGZ1bmN0aW9uIHRocm93ZXIoZSkge1xuICAgICAgICBzZXRUaW1lb3V0KGZ1bmN0aW9uKCl7dGhyb3cgZTt9LCAwKTtcbiAgICB9XG5cbiAgICBmdW5jdGlvbiBjYXN0UHJlc2VydmluZ0Rpc3Bvc2FibGUodGhlbmFibGUpIHtcbiAgICAgICAgdmFyIG1heWJlUHJvbWlzZSA9IGNhc3QodGhlbmFibGUsIHZvaWQgMCk7XG4gICAgICAgIGlmIChtYXliZVByb21pc2UgIT09IHRoZW5hYmxlICYmXG4gICAgICAgICAgICB0eXBlb2YgdGhlbmFibGUuX2lzRGlzcG9zYWJsZSA9PT0gXCJmdW5jdGlvblwiICYmXG4gICAgICAgICAgICB0eXBlb2YgdGhlbmFibGUuX2dldERpc3Bvc2VyID09PSBcImZ1bmN0aW9uXCIgJiZcbiAgICAgICAgICAgIHRoZW5hYmxlLl9pc0Rpc3Bvc2FibGUoKSkge1xuICAgICAgICAgICAgbWF5YmVQcm9taXNlLl9zZXREaXNwb3NhYmxlKHRoZW5hYmxlLl9nZXREaXNwb3NlcigpKTtcbiAgICAgICAgfVxuICAgICAgICByZXR1cm4gbWF5YmVQcm9taXNlO1xuICAgIH1cbiAgICBmdW5jdGlvbiBkaXNwb3NlKHJlc291cmNlcywgaW5zcGVjdGlvbikge1xuICAgICAgICB2YXIgaSA9IDA7XG4gICAgICAgIHZhciBsZW4gPSByZXNvdXJjZXMubGVuZ3RoO1xuICAgICAgICB2YXIgcmV0ID0gUHJvbWlzZS5kZWZlcigpO1xuICAgICAgICBmdW5jdGlvbiBpdGVyYXRvcigpIHtcbiAgICAgICAgICAgIGlmIChpID49IGxlbikgcmV0dXJuIHJldC5yZXNvbHZlKCk7XG4gICAgICAgICAgICB2YXIgbWF5YmVQcm9taXNlID0gY2FzdFByZXNlcnZpbmdEaXNwb3NhYmxlKHJlc291cmNlc1tpKytdKTtcbiAgICAgICAgICAgIGlmIChtYXliZVByb21pc2UgaW5zdGFuY2VvZiBQcm9taXNlICYmXG4gICAgICAgICAgICAgICAgbWF5YmVQcm9taXNlLl9pc0Rpc3Bvc2FibGUoKSkge1xuICAgICAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgICAgICAgIG1heWJlUHJvbWlzZSA9IGNhc3QobWF5YmVQcm9taXNlLl9nZXREaXNwb3NlcigpXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgLnRyeURpc3Bvc2UoaW5zcGVjdGlvbiksIHZvaWQgMCk7XG4gICAgICAgICAgICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhyb3dlcihlKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgaWYgKG1heWJlUHJvbWlzZSBpbnN0YW5jZW9mIFByb21pc2UpIHtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIG1heWJlUHJvbWlzZS5fdGhlbihpdGVyYXRvciwgdGhyb3dlcixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBudWxsLCBudWxsLCBudWxsKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBpdGVyYXRvcigpO1xuICAgICAgICB9XG4gICAgICAgIGl0ZXJhdG9yKCk7XG4gICAgICAgIHJldHVybiByZXQucHJvbWlzZTtcbiAgICB9XG5cbiAgICBmdW5jdGlvbiBkaXNwb3NlclN1Y2Nlc3ModmFsdWUpIHtcbiAgICAgICAgdmFyIGluc3BlY3Rpb24gPSBuZXcgUHJvbWlzZUluc3BlY3Rpb24oKTtcbiAgICAgICAgaW5zcGVjdGlvbi5fc2V0dGxlZFZhbHVlID0gdmFsdWU7XG4gICAgICAgIGluc3BlY3Rpb24uX2JpdEZpZWxkID0gMjY4NDM1NDU2O1xuICAgICAgICByZXR1cm4gZGlzcG9zZSh0aGlzLCBpbnNwZWN0aW9uKS50aGVuUmV0dXJuKHZhbHVlKTtcbiAgICB9XG5cbiAgICBmdW5jdGlvbiBkaXNwb3NlckZhaWwocmVhc29uKSB7XG4gICAgICAgIHZhciBpbnNwZWN0aW9uID0gbmV3IFByb21pc2VJbnNwZWN0aW9uKCk7XG4gICAgICAgIGluc3BlY3Rpb24uX3NldHRsZWRWYWx1ZSA9IHJlYXNvbjtcbiAgICAgICAgaW5zcGVjdGlvbi5fYml0RmllbGQgPSAxMzQyMTc3Mjg7XG4gICAgICAgIHJldHVybiBkaXNwb3NlKHRoaXMsIGluc3BlY3Rpb24pLnRoZW5UaHJvdyhyZWFzb24pO1xuICAgIH1cblxuICAgIGZ1bmN0aW9uIERpc3Bvc2VyKGRhdGEsIHByb21pc2UpIHtcbiAgICAgICAgdGhpcy5fZGF0YSA9IGRhdGE7XG4gICAgICAgIHRoaXMuX3Byb21pc2UgPSBwcm9taXNlO1xuICAgIH1cblxuICAgIERpc3Bvc2VyLnByb3RvdHlwZS5kYXRhID0gZnVuY3Rpb24gRGlzcG9zZXIkZGF0YSgpIHtcbiAgICAgICAgcmV0dXJuIHRoaXMuX2RhdGE7XG4gICAgfTtcblxuICAgIERpc3Bvc2VyLnByb3RvdHlwZS5wcm9taXNlID0gZnVuY3Rpb24gRGlzcG9zZXIkcHJvbWlzZSgpIHtcbiAgICAgICAgcmV0dXJuIHRoaXMuX3Byb21pc2U7XG4gICAgfTtcblxuICAgIERpc3Bvc2VyLnByb3RvdHlwZS5yZXNvdXJjZSA9IGZ1bmN0aW9uIERpc3Bvc2VyJHJlc291cmNlKCkge1xuICAgICAgICBpZiAodGhpcy5wcm9taXNlKCkuaXNGdWxmaWxsZWQoKSkge1xuICAgICAgICAgICAgcmV0dXJuIHRoaXMucHJvbWlzZSgpLnZhbHVlKCk7XG4gICAgICAgIH1cbiAgICAgICAgcmV0dXJuIG51bGw7XG4gICAgfTtcblxuICAgIERpc3Bvc2VyLnByb3RvdHlwZS50cnlEaXNwb3NlID0gZnVuY3Rpb24oaW5zcGVjdGlvbikge1xuICAgICAgICB2YXIgcmVzb3VyY2UgPSB0aGlzLnJlc291cmNlKCk7XG4gICAgICAgIHZhciByZXQgPSByZXNvdXJjZSAhPT0gbnVsbFxuICAgICAgICAgICAgPyB0aGlzLmRvRGlzcG9zZShyZXNvdXJjZSwgaW5zcGVjdGlvbikgOiBudWxsO1xuICAgICAgICB0aGlzLl9wcm9taXNlLl91bnNldERpc3Bvc2FibGUoKTtcbiAgICAgICAgdGhpcy5fZGF0YSA9IHRoaXMuX3Byb21pc2UgPSBudWxsO1xuICAgICAgICByZXR1cm4gcmV0O1xuICAgIH07XG5cbiAgICBEaXNwb3Nlci5pc0Rpc3Bvc2VyID0gZnVuY3Rpb24gRGlzcG9zZXIkaXNEaXNwb3NlcihkKSB7XG4gICAgICAgIHJldHVybiAoZCAhPSBudWxsICYmXG4gICAgICAgICAgICAgICAgdHlwZW9mIGQucmVzb3VyY2UgPT09IFwiZnVuY3Rpb25cIiAmJlxuICAgICAgICAgICAgICAgIHR5cGVvZiBkLnRyeURpc3Bvc2UgPT09IFwiZnVuY3Rpb25cIik7XG4gICAgfTtcblxuICAgIGZ1bmN0aW9uIEZ1bmN0aW9uRGlzcG9zZXIoZm4sIHByb21pc2UpIHtcbiAgICAgICAgdGhpcy5jb25zdHJ1Y3RvciQoZm4sIHByb21pc2UpO1xuICAgIH1cbiAgICBpbmhlcml0cyhGdW5jdGlvbkRpc3Bvc2VyLCBEaXNwb3Nlcik7XG5cbiAgICBGdW5jdGlvbkRpc3Bvc2VyLnByb3RvdHlwZS5kb0Rpc3Bvc2UgPSBmdW5jdGlvbiAocmVzb3VyY2UsIGluc3BlY3Rpb24pIHtcbiAgICAgICAgdmFyIGZuID0gdGhpcy5kYXRhKCk7XG4gICAgICAgIHJldHVybiBmbi5jYWxsKHJlc291cmNlLCByZXNvdXJjZSwgaW5zcGVjdGlvbik7XG4gICAgfTtcblxuICAgIFByb21pc2UudXNpbmcgPSBmdW5jdGlvbiBQcm9taXNlJHVzaW5nKCkge1xuICAgICAgICB2YXIgbGVuID0gYXJndW1lbnRzLmxlbmd0aDtcbiAgICAgICAgaWYgKGxlbiA8IDIpIHJldHVybiBhcGlSZWplY3Rpb24oXG4gICAgICAgICAgICAgICAgICAgICAgICBcInlvdSBtdXN0IHBhc3MgYXQgbGVhc3QgMiBhcmd1bWVudHMgdG8gUHJvbWlzZS51c2luZ1wiKTtcbiAgICAgICAgdmFyIGZuID0gYXJndW1lbnRzW2xlbiAtIDFdO1xuICAgICAgICBpZiAodHlwZW9mIGZuICE9PSBcImZ1bmN0aW9uXCIpIHJldHVybiBhcGlSZWplY3Rpb24oXCJmbiBtdXN0IGJlIGEgZnVuY3Rpb25cIik7XG4gICAgICAgIGxlbi0tO1xuICAgICAgICB2YXIgcmVzb3VyY2VzID0gbmV3IEFycmF5KGxlbik7XG4gICAgICAgIGZvciAodmFyIGkgPSAwOyBpIDwgbGVuOyArK2kpIHtcbiAgICAgICAgICAgIHZhciByZXNvdXJjZSA9IGFyZ3VtZW50c1tpXTtcbiAgICAgICAgICAgIGlmIChEaXNwb3Nlci5pc0Rpc3Bvc2VyKHJlc291cmNlKSkge1xuICAgICAgICAgICAgICAgIHZhciBkaXNwb3NlciA9IHJlc291cmNlO1xuICAgICAgICAgICAgICAgIHJlc291cmNlID0gcmVzb3VyY2UucHJvbWlzZSgpO1xuICAgICAgICAgICAgICAgIHJlc291cmNlLl9zZXREaXNwb3NhYmxlKGRpc3Bvc2VyKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHJlc291cmNlc1tpXSA9IHJlc291cmNlO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIFByb21pc2Uuc2V0dGxlKHJlc291cmNlcylcbiAgICAgICAgICAgIC50aGVuKGluc3BlY3Rpb25NYXBwZXIpXG4gICAgICAgICAgICAuc3ByZWFkKGZuKVxuICAgICAgICAgICAgLl90aGVuKGRpc3Bvc2VyU3VjY2VzcywgZGlzcG9zZXJGYWlsLCB2b2lkIDAsIHJlc291cmNlcywgdm9pZCAwKTtcbiAgICB9O1xuXG4gICAgUHJvbWlzZS5wcm90b3R5cGUuX3NldERpc3Bvc2FibGUgPVxuICAgIGZ1bmN0aW9uIFByb21pc2UkX3NldERpc3Bvc2FibGUoZGlzcG9zZXIpIHtcbiAgICAgICAgdGhpcy5fYml0RmllbGQgPSB0aGlzLl9iaXRGaWVsZCB8IDI2MjE0NDtcbiAgICAgICAgdGhpcy5fZGlzcG9zZXIgPSBkaXNwb3NlcjtcbiAgICB9O1xuXG4gICAgUHJvbWlzZS5wcm90b3R5cGUuX2lzRGlzcG9zYWJsZSA9IGZ1bmN0aW9uIFByb21pc2UkX2lzRGlzcG9zYWJsZSgpIHtcbiAgICAgICAgcmV0dXJuICh0aGlzLl9iaXRGaWVsZCAmIDI2MjE0NCkgPiAwO1xuICAgIH07XG5cbiAgICBQcm9taXNlLnByb3RvdHlwZS5fZ2V0RGlzcG9zZXIgPSBmdW5jdGlvbiBQcm9taXNlJF9nZXREaXNwb3NlcigpIHtcbiAgICAgICAgcmV0dXJuIHRoaXMuX2Rpc3Bvc2VyO1xuICAgIH07XG5cbiAgICBQcm9taXNlLnByb3RvdHlwZS5fdW5zZXREaXNwb3NhYmxlID0gZnVuY3Rpb24gUHJvbWlzZSRfdW5zZXREaXNwb3NhYmxlKCkge1xuICAgICAgICB0aGlzLl9iaXRGaWVsZCA9IHRoaXMuX2JpdEZpZWxkICYgKH4yNjIxNDQpO1xuICAgICAgICB0aGlzLl9kaXNwb3NlciA9IHZvaWQgMDtcbiAgICB9O1xuXG4gICAgUHJvbWlzZS5wcm90b3R5cGUuZGlzcG9zZXIgPSBmdW5jdGlvbiBQcm9taXNlJGRpc3Bvc2VyKGZuKSB7XG4gICAgICAgIGlmICh0eXBlb2YgZm4gPT09IFwiZnVuY3Rpb25cIikge1xuICAgICAgICAgICAgcmV0dXJuIG5ldyBGdW5jdGlvbkRpc3Bvc2VyKGZuLCB0aGlzKTtcbiAgICAgICAgfVxuICAgICAgICB0aHJvdyBuZXcgVHlwZUVycm9yKCk7XG4gICAgfTtcblxufTtcbiIsIi8qKlxuICogVGhlIE1JVCBMaWNlbnNlIChNSVQpXG4gKiBcbiAqIENvcHlyaWdodCAoYykgMjAxNCBQZXRrYSBBbnRvbm92XG4gKiBcbiAqIFBlcm1pc3Npb24gaXMgaGVyZWJ5IGdyYW50ZWQsIGZyZWUgb2YgY2hhcmdlLCB0byBhbnkgcGVyc29uIG9idGFpbmluZyBhIGNvcHlcbiAqIG9mIHRoaXMgc29mdHdhcmUgYW5kIGFzc29jaWF0ZWQgZG9jdW1lbnRhdGlvbiBmaWxlcyAodGhlIFwiU29mdHdhcmVcIiksIHRvIGRlYWxcbiAqIGluIHRoZSBTb2Z0d2FyZSB3aXRob3V0IHJlc3RyaWN0aW9uLCBpbmNsdWRpbmcgd2l0aG91dCBsaW1pdGF0aW9uIHRoZSByaWdodHNcbiAqIHRvIHVzZSwgY29weSwgbW9kaWZ5LCBtZXJnZSwgcHVibGlzaCwgZGlzdHJpYnV0ZSwgc3VibGljZW5zZSwgYW5kL29yIHNlbGxcbiAqIGNvcGllcyBvZiB0aGUgU29mdHdhcmUsIGFuZCB0byBwZXJtaXQgcGVyc29ucyB0byB3aG9tIHRoZSBTb2Z0d2FyZSBpc1xuICogZnVybmlzaGVkIHRvIGRvIHNvLCBzdWJqZWN0IHRvIHRoZSBmb2xsb3dpbmcgY29uZGl0aW9uczo8L3A+XG4gKiBcbiAqIFRoZSBhYm92ZSBjb3B5cmlnaHQgbm90aWNlIGFuZCB0aGlzIHBlcm1pc3Npb24gbm90aWNlIHNoYWxsIGJlIGluY2x1ZGVkIGluXG4gKiBhbGwgY29waWVzIG9yIHN1YnN0YW50aWFsIHBvcnRpb25zIG9mIHRoZSBTb2Z0d2FyZS5cbiAqIFxuICogVEhFIFNPRlRXQVJFIElTIFBST1ZJREVEIFwiQVMgSVNcIiwgV0lUSE9VVCBXQVJSQU5UWSBPRiBBTlkgS0lORCwgRVhQUkVTUyBPUlxuICogSU1QTElFRCwgSU5DTFVESU5HIEJVVCBOT1QgTElNSVRFRCBUTyBUSEUgV0FSUkFOVElFUyBPRiBNRVJDSEFOVEFCSUxJVFksXG4gKiBGSVRORVNTIEZPUiBBIFBBUlRJQ1VMQVIgUFVSUE9TRSBBTkQgTk9OSU5GUklOR0VNRU5ULiAgSU4gTk8gRVZFTlQgU0hBTEwgVEhFXG4gKiBBVVRIT1JTIE9SIENPUFlSSUdIVCBIT0xERVJTIEJFIExJQUJMRSBGT1IgQU5ZIENMQUlNLCBEQU1BR0VTIE9SIE9USEVSXG4gKiBMSUFCSUxJVFksIFdIRVRIRVIgSU4gQU4gQUNUSU9OIE9GIENPTlRSQUNULCBUT1JUIE9SIE9USEVSV0lTRSwgQVJJU0lORyBGUk9NLFxuICogT1VUIE9GIE9SIElOIENPTk5FQ1RJT04gV0lUSCBUSEUgU09GVFdBUkUgT1IgVEhFIFVTRSBPUiBPVEhFUiBERUFMSU5HUyBJTlxuICogVEhFIFNPRlRXQVJFLlxuICogXG4gKi9cblwidXNlIHN0cmljdFwiO1xudmFyIGVzNSA9IHJlcXVpcmUoXCIuL2VzNS5qc1wiKTtcbnZhciBoYXZlR2V0dGVycyA9IChmdW5jdGlvbigpe1xuICAgIHRyeSB7XG4gICAgICAgIHZhciBvID0ge307XG4gICAgICAgIGVzNS5kZWZpbmVQcm9wZXJ0eShvLCBcImZcIiwge1xuICAgICAgICAgICAgZ2V0OiBmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIDM7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0pO1xuICAgICAgICByZXR1cm4gby5mID09PSAzO1xuICAgIH1cbiAgICBjYXRjaCAoZSkge1xuICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgfVxuXG59KSgpO1xudmFyIGNhbkV2YWx1YXRlID0gdHlwZW9mIG5hdmlnYXRvciA9PSBcInVuZGVmaW5lZFwiO1xudmFyIGVycm9yT2JqID0ge2U6IHt9fTtcbmZ1bmN0aW9uIHRyeUNhdGNoMShmbiwgcmVjZWl2ZXIsIGFyZykge1xuICAgIHRyeSB7IHJldHVybiBmbi5jYWxsKHJlY2VpdmVyLCBhcmcpOyB9XG4gICAgY2F0Y2ggKGUpIHtcbiAgICAgICAgZXJyb3JPYmouZSA9IGU7XG4gICAgICAgIHJldHVybiBlcnJvck9iajtcbiAgICB9XG59XG5cbmZ1bmN0aW9uIHRyeUNhdGNoMihmbiwgcmVjZWl2ZXIsIGFyZywgYXJnMikge1xuICAgIHRyeSB7IHJldHVybiBmbi5jYWxsKHJlY2VpdmVyLCBhcmcsIGFyZzIpOyB9XG4gICAgY2F0Y2ggKGUpIHtcbiAgICAgICAgZXJyb3JPYmouZSA9IGU7XG4gICAgICAgIHJldHVybiBlcnJvck9iajtcbiAgICB9XG59XG5cbmZ1bmN0aW9uIHRyeUNhdGNoMyhmbiwgcmVjZWl2ZXIsIGFyZywgYXJnMiwgYXJnMykge1xuICAgIHRyeSB7IHJldHVybiBmbi5jYWxsKHJlY2VpdmVyLCBhcmcsIGFyZzIsIGFyZzMpOyB9XG4gICAgY2F0Y2ggKGUpIHtcbiAgICAgICAgZXJyb3JPYmouZSA9IGU7XG4gICAgICAgIHJldHVybiBlcnJvck9iajtcbiAgICB9XG59XG5cbmZ1bmN0aW9uIHRyeUNhdGNoNChmbiwgcmVjZWl2ZXIsIGFyZywgYXJnMiwgYXJnMywgYXJnNCkge1xuICAgIHRyeSB7IHJldHVybiBmbi5jYWxsKHJlY2VpdmVyLCBhcmcsIGFyZzIsIGFyZzMsIGFyZzQpOyB9XG4gICAgY2F0Y2ggKGUpIHtcbiAgICAgICAgZXJyb3JPYmouZSA9IGU7XG4gICAgICAgIHJldHVybiBlcnJvck9iajtcbiAgICB9XG59XG5cbmZ1bmN0aW9uIHRyeUNhdGNoQXBwbHkoZm4sIGFyZ3MsIHJlY2VpdmVyKSB7XG4gICAgdHJ5IHsgcmV0dXJuIGZuLmFwcGx5KHJlY2VpdmVyLCBhcmdzKTsgfVxuICAgIGNhdGNoIChlKSB7XG4gICAgICAgIGVycm9yT2JqLmUgPSBlO1xuICAgICAgICByZXR1cm4gZXJyb3JPYmo7XG4gICAgfVxufVxuXG52YXIgaW5oZXJpdHMgPSBmdW5jdGlvbihDaGlsZCwgUGFyZW50KSB7XG4gICAgdmFyIGhhc1Byb3AgPSB7fS5oYXNPd25Qcm9wZXJ0eTtcblxuICAgIGZ1bmN0aW9uIFQoKSB7XG4gICAgICAgIHRoaXMuY29uc3RydWN0b3IgPSBDaGlsZDtcbiAgICAgICAgdGhpcy5jb25zdHJ1Y3RvciQgPSBQYXJlbnQ7XG4gICAgICAgIGZvciAodmFyIHByb3BlcnR5TmFtZSBpbiBQYXJlbnQucHJvdG90eXBlKSB7XG4gICAgICAgICAgICBpZiAoaGFzUHJvcC5jYWxsKFBhcmVudC5wcm90b3R5cGUsIHByb3BlcnR5TmFtZSkgJiZcbiAgICAgICAgICAgICAgICBwcm9wZXJ0eU5hbWUuY2hhckF0KHByb3BlcnR5TmFtZS5sZW5ndGgtMSkgIT09IFwiJFwiXG4gICAgICAgICAgICkge1xuICAgICAgICAgICAgICAgIHRoaXNbcHJvcGVydHlOYW1lICsgXCIkXCJdID0gUGFyZW50LnByb3RvdHlwZVtwcm9wZXJ0eU5hbWVdO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgfVxuICAgIFQucHJvdG90eXBlID0gUGFyZW50LnByb3RvdHlwZTtcbiAgICBDaGlsZC5wcm90b3R5cGUgPSBuZXcgVCgpO1xuICAgIHJldHVybiBDaGlsZC5wcm90b3R5cGU7XG59O1xuXG5mdW5jdGlvbiBhc1N0cmluZyh2YWwpIHtcbiAgICByZXR1cm4gdHlwZW9mIHZhbCA9PT0gXCJzdHJpbmdcIiA/IHZhbCA6IChcIlwiICsgdmFsKTtcbn1cblxuZnVuY3Rpb24gaXNQcmltaXRpdmUodmFsKSB7XG4gICAgcmV0dXJuIHZhbCA9PSBudWxsIHx8IHZhbCA9PT0gdHJ1ZSB8fCB2YWwgPT09IGZhbHNlIHx8XG4gICAgICAgIHR5cGVvZiB2YWwgPT09IFwic3RyaW5nXCIgfHwgdHlwZW9mIHZhbCA9PT0gXCJudW1iZXJcIjtcblxufVxuXG5mdW5jdGlvbiBpc09iamVjdCh2YWx1ZSkge1xuICAgIHJldHVybiAhaXNQcmltaXRpdmUodmFsdWUpO1xufVxuXG5mdW5jdGlvbiBtYXliZVdyYXBBc0Vycm9yKG1heWJlRXJyb3IpIHtcbiAgICBpZiAoIWlzUHJpbWl0aXZlKG1heWJlRXJyb3IpKSByZXR1cm4gbWF5YmVFcnJvcjtcblxuICAgIHJldHVybiBuZXcgRXJyb3IoYXNTdHJpbmcobWF5YmVFcnJvcikpO1xufVxuXG5mdW5jdGlvbiB3aXRoQXBwZW5kZWQodGFyZ2V0LCBhcHBlbmRlZSkge1xuICAgIHZhciBsZW4gPSB0YXJnZXQubGVuZ3RoO1xuICAgIHZhciByZXQgPSBuZXcgQXJyYXkobGVuICsgMSk7XG4gICAgdmFyIGk7XG4gICAgZm9yIChpID0gMDsgaSA8IGxlbjsgKytpKSB7XG4gICAgICAgIHJldFtpXSA9IHRhcmdldFtpXTtcbiAgICB9XG4gICAgcmV0W2ldID0gYXBwZW5kZWU7XG4gICAgcmV0dXJuIHJldDtcbn1cblxuZnVuY3Rpb24gZ2V0RGF0YVByb3BlcnR5T3JEZWZhdWx0KG9iaiwga2V5LCBkZWZhdWx0VmFsdWUpIHtcbiAgICBpZiAoZXM1LmlzRVM1KSB7XG4gICAgICAgIHZhciBkZXNjID0gT2JqZWN0LmdldE93blByb3BlcnR5RGVzY3JpcHRvcihvYmosIGtleSk7XG4gICAgICAgIGlmIChkZXNjICE9IG51bGwpIHtcbiAgICAgICAgICAgIHJldHVybiBkZXNjLmdldCA9PSBudWxsICYmIGRlc2Muc2V0ID09IG51bGxcbiAgICAgICAgICAgICAgICAgICAgPyBkZXNjLnZhbHVlXG4gICAgICAgICAgICAgICAgICAgIDogZGVmYXVsdFZhbHVlO1xuICAgICAgICB9XG4gICAgfSBlbHNlIHtcbiAgICAgICAgcmV0dXJuIHt9Lmhhc093blByb3BlcnR5LmNhbGwob2JqLCBrZXkpID8gb2JqW2tleV0gOiB2b2lkIDA7XG4gICAgfVxufVxuXG5mdW5jdGlvbiBub3RFbnVtZXJhYmxlUHJvcChvYmosIG5hbWUsIHZhbHVlKSB7XG4gICAgaWYgKGlzUHJpbWl0aXZlKG9iaikpIHJldHVybiBvYmo7XG4gICAgdmFyIGRlc2NyaXB0b3IgPSB7XG4gICAgICAgIHZhbHVlOiB2YWx1ZSxcbiAgICAgICAgY29uZmlndXJhYmxlOiB0cnVlLFxuICAgICAgICBlbnVtZXJhYmxlOiBmYWxzZSxcbiAgICAgICAgd3JpdGFibGU6IHRydWVcbiAgICB9O1xuICAgIGVzNS5kZWZpbmVQcm9wZXJ0eShvYmosIG5hbWUsIGRlc2NyaXB0b3IpO1xuICAgIHJldHVybiBvYmo7XG59XG5cblxudmFyIHdyYXBzUHJpbWl0aXZlUmVjZWl2ZXIgPSAoZnVuY3Rpb24oKSB7XG4gICAgcmV0dXJuIHRoaXMgIT09IFwic3RyaW5nXCI7XG59KS5jYWxsKFwic3RyaW5nXCIpO1xuXG5mdW5jdGlvbiB0aHJvd2VyKHIpIHtcbiAgICB0aHJvdyByO1xufVxuXG52YXIgaW5oZXJpdGVkRGF0YUtleXMgPSAoZnVuY3Rpb24oKSB7XG4gICAgaWYgKGVzNS5pc0VTNSkge1xuICAgICAgICByZXR1cm4gZnVuY3Rpb24ob2JqLCBvcHRzKSB7XG4gICAgICAgICAgICB2YXIgcmV0ID0gW107XG4gICAgICAgICAgICB2YXIgdmlzaXRlZEtleXMgPSBPYmplY3QuY3JlYXRlKG51bGwpO1xuICAgICAgICAgICAgdmFyIGdldEtleXMgPSBPYmplY3Qob3B0cykuaW5jbHVkZUhpZGRlblxuICAgICAgICAgICAgICAgID8gT2JqZWN0LmdldE93blByb3BlcnR5TmFtZXNcbiAgICAgICAgICAgICAgICA6IE9iamVjdC5rZXlzO1xuICAgICAgICAgICAgd2hpbGUgKG9iaiAhPSBudWxsKSB7XG4gICAgICAgICAgICAgICAgdmFyIGtleXM7XG4gICAgICAgICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgICAgICAga2V5cyA9IGdldEtleXMob2JqKTtcbiAgICAgICAgICAgICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiByZXQ7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIGZvciAodmFyIGkgPSAwOyBpIDwga2V5cy5sZW5ndGg7ICsraSkge1xuICAgICAgICAgICAgICAgICAgICB2YXIga2V5ID0ga2V5c1tpXTtcbiAgICAgICAgICAgICAgICAgICAgaWYgKHZpc2l0ZWRLZXlzW2tleV0pIGNvbnRpbnVlO1xuICAgICAgICAgICAgICAgICAgICB2aXNpdGVkS2V5c1trZXldID0gdHJ1ZTtcbiAgICAgICAgICAgICAgICAgICAgdmFyIGRlc2MgPSBPYmplY3QuZ2V0T3duUHJvcGVydHlEZXNjcmlwdG9yKG9iaiwga2V5KTtcbiAgICAgICAgICAgICAgICAgICAgaWYgKGRlc2MgIT0gbnVsbCAmJiBkZXNjLmdldCA9PSBudWxsICYmIGRlc2Muc2V0ID09IG51bGwpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHJldC5wdXNoKGtleSk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgb2JqID0gZXM1LmdldFByb3RvdHlwZU9mKG9iaik7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICByZXR1cm4gcmV0O1xuICAgICAgICB9O1xuICAgIH0gZWxzZSB7XG4gICAgICAgIHJldHVybiBmdW5jdGlvbihvYmopIHtcbiAgICAgICAgICAgIHZhciByZXQgPSBbXTtcbiAgICAgICAgICAgIC8qanNoaW50IGZvcmluOmZhbHNlICovXG4gICAgICAgICAgICBmb3IgKHZhciBrZXkgaW4gb2JqKSB7XG4gICAgICAgICAgICAgICAgcmV0LnB1c2goa2V5KTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHJldHVybiByZXQ7XG4gICAgICAgIH07XG4gICAgfVxuXG59KSgpO1xuXG5mdW5jdGlvbiBpc0NsYXNzKGZuKSB7XG4gICAgdHJ5IHtcbiAgICAgICAgaWYgKHR5cGVvZiBmbiA9PT0gXCJmdW5jdGlvblwiKSB7XG4gICAgICAgICAgICB2YXIga2V5cyA9IGVzNS5rZXlzKGZuLnByb3RvdHlwZSk7XG4gICAgICAgICAgICByZXR1cm4ga2V5cy5sZW5ndGggPiAwICYmXG4gICAgICAgICAgICAgICAgICAgIShrZXlzLmxlbmd0aCA9PT0gMSAmJiBrZXlzWzBdID09PSBcImNvbnN0cnVjdG9yXCIpO1xuICAgICAgICB9XG4gICAgICAgIHJldHVybiBmYWxzZTtcbiAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgIHJldHVybiBmYWxzZTtcbiAgICB9XG59XG5cbmZ1bmN0aW9uIHRvRmFzdFByb3BlcnRpZXMob2JqKSB7XG4gICAgLypqc2hpbnQgLVcwMjcqL1xuICAgIGZ1bmN0aW9uIGYoKSB7fVxuICAgIGYucHJvdG90eXBlID0gb2JqO1xuICAgIHJldHVybiBmO1xuICAgIGV2YWwob2JqKTtcbn1cblxudmFyIHJpZGVudCA9IC9eW2EteiRfXVthLXokXzAtOV0qJC9pO1xuZnVuY3Rpb24gaXNJZGVudGlmaWVyKHN0cikge1xuICAgIHJldHVybiByaWRlbnQudGVzdChzdHIpO1xufVxuXG5mdW5jdGlvbiBmaWxsZWRSYW5nZShjb3VudCwgcHJlZml4LCBzdWZmaXgpIHtcbiAgICB2YXIgcmV0ID0gbmV3IEFycmF5KGNvdW50KTtcbiAgICBmb3IodmFyIGkgPSAwOyBpIDwgY291bnQ7ICsraSkge1xuICAgICAgICByZXRbaV0gPSBwcmVmaXggKyBpICsgc3VmZml4O1xuICAgIH1cbiAgICByZXR1cm4gcmV0O1xufVxuXG52YXIgcmV0ID0ge1xuICAgIGlzQ2xhc3M6IGlzQ2xhc3MsXG4gICAgaXNJZGVudGlmaWVyOiBpc0lkZW50aWZpZXIsXG4gICAgaW5oZXJpdGVkRGF0YUtleXM6IGluaGVyaXRlZERhdGFLZXlzLFxuICAgIGdldERhdGFQcm9wZXJ0eU9yRGVmYXVsdDogZ2V0RGF0YVByb3BlcnR5T3JEZWZhdWx0LFxuICAgIHRocm93ZXI6IHRocm93ZXIsXG4gICAgaXNBcnJheTogZXM1LmlzQXJyYXksXG4gICAgaGF2ZUdldHRlcnM6IGhhdmVHZXR0ZXJzLFxuICAgIG5vdEVudW1lcmFibGVQcm9wOiBub3RFbnVtZXJhYmxlUHJvcCxcbiAgICBpc1ByaW1pdGl2ZTogaXNQcmltaXRpdmUsXG4gICAgaXNPYmplY3Q6IGlzT2JqZWN0LFxuICAgIGNhbkV2YWx1YXRlOiBjYW5FdmFsdWF0ZSxcbiAgICBlcnJvck9iajogZXJyb3JPYmosXG4gICAgdHJ5Q2F0Y2gxOiB0cnlDYXRjaDEsXG4gICAgdHJ5Q2F0Y2gyOiB0cnlDYXRjaDIsXG4gICAgdHJ5Q2F0Y2gzOiB0cnlDYXRjaDMsXG4gICAgdHJ5Q2F0Y2g0OiB0cnlDYXRjaDQsXG4gICAgdHJ5Q2F0Y2hBcHBseTogdHJ5Q2F0Y2hBcHBseSxcbiAgICBpbmhlcml0czogaW5oZXJpdHMsXG4gICAgd2l0aEFwcGVuZGVkOiB3aXRoQXBwZW5kZWQsXG4gICAgYXNTdHJpbmc6IGFzU3RyaW5nLFxuICAgIG1heWJlV3JhcEFzRXJyb3I6IG1heWJlV3JhcEFzRXJyb3IsXG4gICAgd3JhcHNQcmltaXRpdmVSZWNlaXZlcjogd3JhcHNQcmltaXRpdmVSZWNlaXZlcixcbiAgICB0b0Zhc3RQcm9wZXJ0aWVzOiB0b0Zhc3RQcm9wZXJ0aWVzLFxuICAgIGZpbGxlZFJhbmdlOiBmaWxsZWRSYW5nZVxufTtcblxubW9kdWxlLmV4cG9ydHMgPSByZXQ7XG4iLCIvKmpzbGludCBub2RlOnRydWUqL1xuLypnbG9iYWxzIFJUQ1BlZXJDb25uZWN0aW9uLCBtb3pSVENQZWVyQ29ubmVjdGlvbiwgd2Via2l0UlRDUGVlckNvbm5lY3Rpb24gKi9cbi8qZ2xvYmFscyBSVENTZXNzaW9uRGVzY3JpcHRpb24sIG1velJUQ1Nlc3Npb25EZXNjcmlwdGlvbiAqL1xuLypnbG9iYWxzIFJUQ0ljZUNhbmRpZGF0ZSwgbW96UlRDSWNlQ2FuZGlkYXRlICovXG4ndXNlIHN0cmljdCc7XG5cbnZhciBteVJUQ1BlZXJDb25uZWN0aW9uID0gbnVsbDtcbnZhciBteVJUQ1Nlc3Npb25EZXNjcmlwdGlvbiA9IG51bGw7XG52YXIgbXlSVENJY2VDYW5kaWRhdGUgPSBudWxsO1xuXG52YXIgcmVuYW1lSWNlVVJMcyA9IGZ1bmN0aW9uIChjb25maWcpIHtcbiAgaWYgKCFjb25maWcpIHtcbiAgICByZXR1cm47XG4gIH1cbiAgaWYgKCFjb25maWcuaWNlU2VydmVycykge1xuICAgIHJldHVybiBjb25maWc7XG4gIH1cbiAgY29uZmlnLmljZVNlcnZlcnMuZm9yRWFjaChmdW5jdGlvbiAoc2VydmVyKSB7XG4gICAgc2VydmVyLnVybCA9IHNlcnZlci51cmxzO1xuICAgIGRlbGV0ZSBzZXJ2ZXIudXJscztcbiAgfSk7XG4gIHJldHVybiBjb25maWc7XG59O1xuXG52YXIgZml4Q2hyb21lU3RhdHNSZXNwb25zZSA9IGZ1bmN0aW9uKHJlc3BvbnNlKSB7XG4gIHZhciBzdGFuZGFyZFJlcG9ydCA9IHt9O1xuICB2YXIgcmVwb3J0cyA9IHJlc3BvbnNlLnJlc3VsdCgpO1xuICByZXBvcnRzLmZvckVhY2goZnVuY3Rpb24ocmVwb3J0KSB7XG4gICAgdmFyIHN0YW5kYXJkU3RhdHMgPSB7XG4gICAgICBpZDogcmVwb3J0LmlkLFxuICAgICAgdGltZXN0YW1wOiByZXBvcnQudGltZXN0YW1wLFxuICAgICAgdHlwZTogcmVwb3J0LnR5cGVcbiAgICB9O1xuICAgIHJlcG9ydC5uYW1lcygpLmZvckVhY2goZnVuY3Rpb24obmFtZSkge1xuICAgICAgc3RhbmRhcmRTdGF0c1tuYW1lXSA9IHJlcG9ydC5zdGF0KG5hbWUpO1xuICAgIH0pO1xuICAgIHN0YW5kYXJkUmVwb3J0W3N0YW5kYXJkU3RhdHMuaWRdID0gc3RhbmRhcmRTdGF0cztcbiAgfSk7XG5cbiAgcmV0dXJuIHN0YW5kYXJkUmVwb3J0O1xufTtcblxudmFyIHNlc3Npb25IYXNEYXRhID0gZnVuY3Rpb24oZGVzYykge1xuICBpZiAoIWRlc2MpIHtcbiAgICByZXR1cm4gZmFsc2U7XG4gIH1cbiAgdmFyIGhhc0RhdGEgPSBmYWxzZTtcbiAgdmFyIHByZWZpeCA9ICdtPWFwcGxpY2F0aW9uJztcbiAgZGVzYy5zZHAuc3BsaXQoJ1xcbicpLmZvckVhY2goZnVuY3Rpb24obGluZSkge1xuICAgIGlmIChsaW5lLnNsaWNlKDAsIHByZWZpeC5sZW5ndGgpID09PSBwcmVmaXgpIHtcbiAgICAgIGhhc0RhdGEgPSB0cnVlO1xuICAgIH1cbiAgfSk7XG4gIHJldHVybiBoYXNEYXRhO1xufTtcblxuLy8gVW5pZnkgUGVlckNvbm5lY3Rpb24gT2JqZWN0LlxuaWYgKHR5cGVvZiBSVENQZWVyQ29ubmVjdGlvbiAhPT0gJ3VuZGVmaW5lZCcpIHtcbiAgbXlSVENQZWVyQ29ubmVjdGlvbiA9IFJUQ1BlZXJDb25uZWN0aW9uO1xufSBlbHNlIGlmICh0eXBlb2YgbW96UlRDUGVlckNvbm5lY3Rpb24gIT09ICd1bmRlZmluZWQnKSB7XG4gIG15UlRDUGVlckNvbm5lY3Rpb24gPSBmdW5jdGlvbiAoY29uZmlndXJhdGlvbiwgY29uc3RyYWludHMpIHtcbiAgICAvLyBGaXJlZm94IHVzZXMgJ3VybCcgcmF0aGVyIHRoYW4gJ3VybHMnIGZvciBSVENJY2VTZXJ2ZXIudXJsc1xuICAgIHZhciBwYyA9IG5ldyBtb3pSVENQZWVyQ29ubmVjdGlvbihyZW5hbWVJY2VVUkxzKGNvbmZpZ3VyYXRpb24pLCBjb25zdHJhaW50cyk7XG5cbiAgICAvLyBGaXJlZm94IGRvZXNuJ3QgZmlyZSAnb25uZWdvdGlhdGlvbm5lZWRlZCcgd2hlbiBhIGRhdGEgY2hhbm5lbCBpcyBjcmVhdGVkXG4gICAgLy8gaHR0cHM6Ly9idWd6aWxsYS5tb3ppbGxhLm9yZy9zaG93X2J1Zy5jZ2k/aWQ9ODQwNzI4XG4gICAgdmFyIGRhdGFFbmFibGVkID0gZmFsc2U7XG4gICAgdmFyIGJvdW5kQ3JlYXRlRGF0YUNoYW5uZWwgPSBwYy5jcmVhdGVEYXRhQ2hhbm5lbC5iaW5kKHBjKTtcbiAgICBwYy5jcmVhdGVEYXRhQ2hhbm5lbCA9IGZ1bmN0aW9uKGxhYmVsLCBkYXRhQ2hhbm5lbERpY3QpIHtcbiAgICAgIHZhciBkYyA9IGJvdW5kQ3JlYXRlRGF0YUNoYW5uZWwobGFiZWwsIGRhdGFDaGFubmVsRGljdCk7XG4gICAgICBpZiAoIWRhdGFFbmFibGVkKSB7XG4gICAgICAgIGRhdGFFbmFibGVkID0gdHJ1ZTtcbiAgICAgICAgaWYgKHBjLm9ubmVnb3RpYXRpb25uZWVkZWQgJiZcbiAgICAgICAgICAgICFzZXNzaW9uSGFzRGF0YShwYy5sb2NhbERlc2NyaXB0aW9uKSAmJlxuICAgICAgICAgICAgIXNlc3Npb25IYXNEYXRhKHBjLnJlbW90ZURlc2NyaXB0aW9uKSkge1xuICAgICAgICAgIHZhciBldmVudCA9IG5ldyBFdmVudCgnbmVnb3RpYXRpb25uZWVkZWQnKTtcbiAgICAgICAgICBwYy5vbm5lZ290aWF0aW9ubmVlZGVkKGV2ZW50KTtcbiAgICAgICAgfVxuICAgICAgfVxuICAgICAgcmV0dXJuIGRjO1xuICAgIH07XG5cbiAgICByZXR1cm4gcGM7XG4gIH07XG59IGVsc2UgaWYgKHR5cGVvZiB3ZWJraXRSVENQZWVyQ29ubmVjdGlvbiAhPT0gJ3VuZGVmaW5lZCcpIHtcbiAgLy8gQ2hyb21lIHJldHVybnMgYSBub25zdGFuZGFyZCwgbm9uLUpTT04taWZpYWJsZSByZXNwb25zZSBmcm9tIGdldFN0YXRzLlxuICBteVJUQ1BlZXJDb25uZWN0aW9uID0gZnVuY3Rpb24oY29uZmlndXJhdGlvbiwgY29uc3RyYWludHMpIHtcbiAgICB2YXIgcGMgPSBuZXcgd2Via2l0UlRDUGVlckNvbm5lY3Rpb24oY29uZmlndXJhdGlvbiwgY29uc3RyYWludHMpO1xuICAgIHZhciBib3VuZEdldFN0YXRzID0gcGMuZ2V0U3RhdHMuYmluZChwYyk7XG4gICAgcGMuZ2V0U3RhdHMgPSBmdW5jdGlvbihzZWxlY3Rvciwgc3VjY2Vzc0NhbGxiYWNrLCBmYWlsdXJlQ2FsbGJhY2spIHtcbiAgICAgIHZhciBzdWNjZXNzQ2FsbGJhY2tXcmFwcGVyID0gZnVuY3Rpb24oY2hyb21lU3RhdHNSZXNwb25zZSkge1xuICAgICAgICBzdWNjZXNzQ2FsbGJhY2soZml4Q2hyb21lU3RhdHNSZXNwb25zZShjaHJvbWVTdGF0c1Jlc3BvbnNlKSk7XG4gICAgICB9O1xuICAgICAgLy8gQ2hyb21lIGFsc28gdGFrZXMgaXRzIGFyZ3VtZW50cyBpbiB0aGUgd3Jvbmcgb3JkZXIuXG4gICAgICBib3VuZEdldFN0YXRzKHN1Y2Nlc3NDYWxsYmFja1dyYXBwZXIsIGZhaWx1cmVDYWxsYmFjaywgc2VsZWN0b3IpO1xuICAgIH07XG4gICAgcmV0dXJuIHBjO1xuICB9O1xufVxuXG4vLyBVbmlmeSBTZXNzaW9uRGVzY3JwdGlvbiBPYmplY3QuXG5pZiAodHlwZW9mIFJUQ1Nlc3Npb25EZXNjcmlwdGlvbiAhPT0gJ3VuZGVmaW5lZCcpIHtcbiAgbXlSVENTZXNzaW9uRGVzY3JpcHRpb24gPSBSVENTZXNzaW9uRGVzY3JpcHRpb247XG59IGVsc2UgaWYgKHR5cGVvZiBtb3pSVENTZXNzaW9uRGVzY3JpcHRpb24gIT09ICd1bmRlZmluZWQnKSB7XG4gIG15UlRDU2Vzc2lvbkRlc2NyaXB0aW9uID0gbW96UlRDU2Vzc2lvbkRlc2NyaXB0aW9uO1xufVxuXG4vLyBVbmlmeSBJY2VDYW5kaWRhdGUgT2JqZWN0LlxuaWYgKHR5cGVvZiBSVENJY2VDYW5kaWRhdGUgIT09ICd1bmRlZmluZWQnKSB7XG4gIG15UlRDSWNlQ2FuZGlkYXRlID0gUlRDSWNlQ2FuZGlkYXRlO1xufSBlbHNlIGlmICh0eXBlb2YgbW96UlRDSWNlQ2FuZGlkYXRlICE9PSAndW5kZWZpbmVkJykge1xuICBteVJUQ0ljZUNhbmRpZGF0ZSA9IG1velJUQ0ljZUNhbmRpZGF0ZTtcbn1cblxuZXhwb3J0cy5SVENQZWVyQ29ubmVjdGlvbiA9IG15UlRDUGVlckNvbm5lY3Rpb247XG5leHBvcnRzLlJUQ1Nlc3Npb25EZXNjcmlwdGlvbiA9IG15UlRDU2Vzc2lvbkRlc2NyaXB0aW9uO1xuZXhwb3J0cy5SVENJY2VDYW5kaWRhdGUgPSBteVJUQ0ljZUNhbmRpZGF0ZTtcbiIsIi8qKlxyXG4gKiBDcmVhdGVkIGJ5IEp1bGlhbiBvbiAxMi8xMC8yMDE0LlxyXG4gKi9cclxuKGZ1bmN0aW9uIChleHBvcnRzKSB7XHJcblxyXG4gICAgLy8gcGVyZm9ybWFuY2Uubm93IHBvbHlmaWxsXHJcbiAgICB2YXIgcGVyZiA9IG51bGw7XHJcbiAgICBpZiAodHlwZW9mIHBlcmZvcm1hbmNlID09PSAndW5kZWZpbmVkJykge1xyXG4gICAgICAgIHBlcmYgPSB7fTtcclxuICAgIH0gZWxzZSB7XHJcbiAgICAgICAgcGVyZiA9IHBlcmZvcm1hbmNlO1xyXG4gICAgfVxyXG5cclxuICAgIHBlcmYubm93ID0gcGVyZi5ub3cgfHwgcGVyZi5tb3pOb3cgfHwgcGVyZi5tc05vdyB8fCAgcGVyZi5vTm93IHx8IHBlcmYud2Via2l0Tm93IHx8IERhdGUubm93IHx8XHJcbiAgICAgICAgZnVuY3Rpb24gKCkge1xyXG4gICAgICAgICAgICByZXR1cm4gbmV3IERhdGUoKS5nZXRUaW1lKCk7XHJcbiAgICAgICAgfTtcclxuXHJcbiAgICBmdW5jdGlvbiBzd2FwKGFycmF5LCBpLCBqKSB7XHJcbiAgICAgICAgaWYgKGkgIT09IGopIHtcclxuICAgICAgICAgICAgdmFyIHRlbXAgPSBhcnJheVtpXTtcclxuICAgICAgICAgICAgYXJyYXlbaV0gPSBhcnJheVtqXTtcclxuICAgICAgICAgICAgYXJyYXlbal0gPSB0ZW1wO1xyXG4gICAgICAgIH1cclxuICAgIH1cclxuXHJcbiAgICAvKlxyXG4gICAgfn5+fn5+fn5+fn5+fn5+fn5+fn5+fn5+fn5+fn5+fn5+fn5+fn5+fn5+fn5+fn5+fn5+fn5cclxuICAgICAqL1xyXG5cclxuICAgIHZhciBnZXRSYW5kb21JbnQgPSBleHBvcnRzLmdldFJhbmRvbUludCA9IGZ1bmN0aW9uIChtaW4sIG1heCkge1xyXG4gICAgICAgIGlmIChtaW4gPiBtYXgpIHRocm93IG5ldyBFcnJvcihcIm1pbiBtdXN0IGJlIHNtYWxsZXIgdGhhbiBtYXghIHtcIiArIG1pbiArIFwiPlwiICsgbWF4ICsgXCJ9XCIgKTtcclxuICAgICAgICByZXR1cm4gTWF0aC5mbG9vcihNYXRoLnJhbmRvbSgpICogKG1heCAtIG1pbiArIDEpKSArIG1pbjtcclxuICAgIH07XHJcblxyXG4gICAgZXhwb3J0cy5zYW1wbGUgPSBmdW5jdGlvbiAobGlzdCwgbikge1xyXG4gICAgICAgIHZhciByZXN1bHQgPSBbXSwgaixpID0gMCwgTCA9IG4gPiBsaXN0Lmxlbmd0aCA/IGxpc3QubGVuZ3RoIDogbiwgcyA9IGxpc3QubGVuZ3RoIC0gMTtcclxuICAgICAgICBmb3IoO2k8TDtpKyspIHtcclxuICAgICAgICAgICAgaiA9IGdldFJhbmRvbUludChpLHMpO1xyXG4gICAgICAgICAgICBzd2FwKGxpc3QsaSxqKTtcclxuICAgICAgICAgICAgcmVzdWx0LnB1c2gobGlzdFtpXSk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIHJldHVybiByZXN1bHQ7XHJcbiAgICB9O1xyXG5cclxuICAgIGV4cG9ydHMuaXNTdHJpbmcgPSBmdW5jdGlvbihteVZhcikge1xyXG4gICAgICAgIHJldHVybiAodHlwZW9mIG15VmFyID09PSAnc3RyaW5nJyB8fCBteVZhciBpbnN0YW5jZW9mIFN0cmluZylcclxuICAgIH07XHJcblxyXG4gICAgZXhwb3J0cy5hc3NlcnRMZW5ndGggPSBmdW5jdGlvbiAoYXJnLCBuYnIpIHtcclxuICAgICAgICBpZiAoYXJnLmxlbmd0aCA9PT0gbmJyKSByZXR1cm4gdHJ1ZTtcclxuICAgICAgICBlbHNlIHRocm93IG5ldyBFcnJvcihcIldyb25nIG51bWJlciBvZiBhcmd1bWVudHM6IGV4cGVjdGVkOlwiICsgbmJyICsgXCIsIGJ1dCBnb3Q6IFwiICsgYXJnLmxlbmd0aCk7XHJcbiAgICB9O1xyXG5cclxuICAgIGV4cG9ydHMuZ3VpZCA9IGZ1bmN0aW9uICgpIHtcclxuICAgICAgICB2YXIgZCA9IHBlcmYubm93KCk7XHJcbiAgICAgICAgdmFyIGd1aWQgPSAneHh4eHh4eHgteHh4eC00eHh4LXl4eHgteHh4eHh4eHh4eHh4Jy5yZXBsYWNlKC9beHldL2csIGZ1bmN0aW9uIChjKSB7XHJcbiAgICAgICAgICAgIHZhciByID0gKGQgKyBNYXRoLnJhbmRvbSgpICogMTYpICUgMTYgfCAwO1xyXG4gICAgICAgICAgICBkID0gTWF0aC5mbG9vcihkIC8gMTYpO1xyXG4gICAgICAgICAgICByZXR1cm4gKGMgPT09ICd4JyA/IHIgOiAociAmIDB4MyB8IDB4OCkpLnRvU3RyaW5nKDE2KTtcclxuICAgICAgICB9KTtcclxuICAgICAgICByZXR1cm4gZ3VpZDtcclxuICAgIH07XHJcblxyXG4gICAgZXhwb3J0cy50aW1lRGlmZmVyZW5jZUluTXMgPSBmdW5jdGlvbiAodHNBLCB0c0IpIHtcclxuICAgICAgICBpZiAodHNBIGluc3RhbmNlb2YgRGF0ZSl7XHJcbiAgICAgICAgICAgIHRzQSA9IHRzQS5nZXRUaW1lKCk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGlmICh0c0IgaW5zdGFuY2VvZiBEYXRlKXtcclxuICAgICAgICAgICAgdHNCID0gdHNCLmdldFRpbWUoKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgcmV0dXJuIE1hdGguYWJzKHRzQSAtIHRzQik7XHJcbiAgICB9O1xyXG5cclxuICAgIC8qKlxyXG4gICAgICogbWlsbGlzZWNvbmRzIHRvIHNlY29uZHNcclxuICAgICAqIEBwYXJhbSBtcyB7TnVtYmVyfSBNaWxsaXNcclxuICAgICAqL1xyXG4gICAgZXhwb3J0cy5tc1RvUyA9IGZ1bmN0aW9uIChtcykge1xyXG4gICAgICAgIHJldHVybiBtcyAvIDEwMDA7XHJcbiAgICB9O1xyXG5cclxuICAgIGV4cG9ydHMuaXNEZWZpbmVkID0gZnVuY3Rpb24gKG8pIHtcclxuICAgICAgICBpZiAobyA9PT0gbnVsbCkgcmV0dXJuIGZhbHNlO1xyXG4gICAgICAgIGlmICh0eXBlb2YgbyA9PT0gXCJ1bmRlZmluZWRcIikgcmV0dXJuIGZhbHNlO1xyXG4gICAgICAgIHJldHVybiB0cnVlO1xyXG4gICAgfTtcclxuXHJcbiAgICAvKipcclxuICAgICAqIFNoYWxsb3cgY2xvbmVcclxuICAgICAqIEBwYXJhbSBsaXN0XHJcbiAgICAgKiBAcmV0dXJucyB7QXJyYXl8c3RyaW5nfEJsb2J9XHJcbiAgICAgKi9cclxuICAgIGV4cG9ydHMuY2xvbmVBcnJheSA9IGZ1bmN0aW9uIChsaXN0KSB7XHJcbiAgICAgICAgcmV0dXJuIGxpc3Quc2xpY2UoMCk7XHJcbiAgICB9XHJcblxyXG4gICAgLyoqXHJcbiAgICAgKiByZW1vdmVzIHRoZSBpdGVtIGF0IHRoZSBwb3NpdGlvbiBhbmQgcmVpbmRleGVzIHRoZSBsaXN0XHJcbiAgICAgKiBAcGFyYW0gbGlzdFxyXG4gICAgICogQHBhcmFtIGlcclxuICAgICAqIEByZXR1cm5zIHsqfVxyXG4gICAgICovXHJcbiAgICBleHBvcnRzLmRlbGV0ZVBvc2l0aW9uID0gZnVuY3Rpb24gKGxpc3QsIGkpIHtcclxuICAgICAgICBpZiAoaSA8IDAgfHwgaSA+PSBsaXN0Lmxlbmd0aCkgdGhyb3cgbmV3IEVycm9yKFwiT3V0IG9mIGJvdW5kc1wiKTtcclxuICAgICAgICBsaXN0LnNwbGljZShpLDEpO1xyXG4gICAgICAgIHJldHVybiBsaXN0O1xyXG4gICAgfTtcclxuXHJcbiAgICAvKipcclxuICAgICAqIENoZWNrcyB3ZWF0aGVyIHRoZSB0aGUgb2JqZWN0IGltcGxlbWVudHMgdGhlIGZ1bGwgaW50ZXJmYWNlIG9yIG5vdFxyXG4gICAgICogQHBhcmFtIG8ge09iamVjdH1cclxuICAgICAqL1xyXG4gICAgdmFyIGltcGxlbWVudHMgPSBleHBvcnRzLmltcGxlbWVudHMgPSBmdW5jdGlvbiAobywgYSkge1xyXG4gICAgICAgIGlmIChBcnJheS5pc0FycmF5KGEpKSB7XHJcbiAgICAgICAgICAgIHJldHVybiBpbXBsZW1lbnRzLmFwcGx5KHt9LFtvXS5jb25jYXQoYSkpO1xyXG4gICAgICAgIH1cclxuICAgICAgICB2YXIgaSA9IDEsIG1ldGhvZE5hbWU7XHJcbiAgICAgICAgd2hpbGUoKG1ldGhvZE5hbWUgPSBhcmd1bWVudHNbaSsrXSkpIHtcclxuICAgICAgICAgICAgaWYgKHR5cGVvZiBvW21ldGhvZE5hbWVdICE9PSBcImZ1bmN0aW9uXCIpIHtcclxuICAgICAgICAgICAgICAgIHJldHVybiBmYWxzZTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgIH1cclxuICAgICAgICByZXR1cm4gdHJ1ZTtcclxuICAgIH07XHJcblxyXG4gICAgLyoqXHJcbiAgICAgKiBJbmhlcml0IHN0dWZmIGZyb20gcGFyZW50XHJcbiAgICAgKiBAcGFyYW0gY2hpbGRcclxuICAgICAqIEBwYXJhbSBwYXJlbnRcclxuICAgICAqL1xyXG4gICAgZXhwb3J0cy5pbmhlcml0ID0gZnVuY3Rpb24gKGNoaWxkLCBwYXJlbnQpIHtcclxuICAgICAgICBjaGlsZC5wcm90b3R5cGUgPSBPYmplY3QuY3JlYXRlKHBhcmVudC5wcm90b3R5cGUpO1xyXG4gICAgfTtcclxuXHJcbn0pKHR5cGVvZiBleHBvcnRzID09PSAndW5kZWZpbmVkJyA/IHRoaXNbJ3lVdGlscyddID0ge30gOiBleHBvcnRzKTsiLCIvLyBzaGltIGZvciB1c2luZyBwcm9jZXNzIGluIGJyb3dzZXJcblxudmFyIHByb2Nlc3MgPSBtb2R1bGUuZXhwb3J0cyA9IHt9O1xudmFyIHF1ZXVlID0gW107XG52YXIgZHJhaW5pbmcgPSBmYWxzZTtcblxuZnVuY3Rpb24gZHJhaW5RdWV1ZSgpIHtcbiAgICBpZiAoZHJhaW5pbmcpIHtcbiAgICAgICAgcmV0dXJuO1xuICAgIH1cbiAgICBkcmFpbmluZyA9IHRydWU7XG4gICAgdmFyIGN1cnJlbnRRdWV1ZTtcbiAgICB2YXIgbGVuID0gcXVldWUubGVuZ3RoO1xuICAgIHdoaWxlKGxlbikge1xuICAgICAgICBjdXJyZW50UXVldWUgPSBxdWV1ZTtcbiAgICAgICAgcXVldWUgPSBbXTtcbiAgICAgICAgdmFyIGkgPSAtMTtcbiAgICAgICAgd2hpbGUgKCsraSA8IGxlbikge1xuICAgICAgICAgICAgY3VycmVudFF1ZXVlW2ldKCk7XG4gICAgICAgIH1cbiAgICAgICAgbGVuID0gcXVldWUubGVuZ3RoO1xuICAgIH1cbiAgICBkcmFpbmluZyA9IGZhbHNlO1xufVxucHJvY2Vzcy5uZXh0VGljayA9IGZ1bmN0aW9uIChmdW4pIHtcbiAgICBxdWV1ZS5wdXNoKGZ1bik7XG4gICAgaWYgKCFkcmFpbmluZykge1xuICAgICAgICBzZXRUaW1lb3V0KGRyYWluUXVldWUsIDApO1xuICAgIH1cbn07XG5cbnByb2Nlc3MudGl0bGUgPSAnYnJvd3Nlcic7XG5wcm9jZXNzLmJyb3dzZXIgPSB0cnVlO1xucHJvY2Vzcy5lbnYgPSB7fTtcbnByb2Nlc3MuYXJndiA9IFtdO1xucHJvY2Vzcy52ZXJzaW9uID0gJyc7IC8vIGVtcHR5IHN0cmluZyB0byBhdm9pZCByZWdleHAgaXNzdWVzXG5cbmZ1bmN0aW9uIG5vb3AoKSB7fVxuXG5wcm9jZXNzLm9uID0gbm9vcDtcbnByb2Nlc3MuYWRkTGlzdGVuZXIgPSBub29wO1xucHJvY2Vzcy5vbmNlID0gbm9vcDtcbnByb2Nlc3Mub2ZmID0gbm9vcDtcbnByb2Nlc3MucmVtb3ZlTGlzdGVuZXIgPSBub29wO1xucHJvY2Vzcy5yZW1vdmVBbGxMaXN0ZW5lcnMgPSBub29wO1xucHJvY2Vzcy5lbWl0ID0gbm9vcDtcblxucHJvY2Vzcy5iaW5kaW5nID0gZnVuY3Rpb24gKG5hbWUpIHtcbiAgICB0aHJvdyBuZXcgRXJyb3IoJ3Byb2Nlc3MuYmluZGluZyBpcyBub3Qgc3VwcG9ydGVkJyk7XG59O1xuXG4vLyBUT0RPKHNodHlsbWFuKVxucHJvY2Vzcy5jd2QgPSBmdW5jdGlvbiAoKSB7IHJldHVybiAnLycgfTtcbnByb2Nlc3MuY2hkaXIgPSBmdW5jdGlvbiAoZGlyKSB7XG4gICAgdGhyb3cgbmV3IEVycm9yKCdwcm9jZXNzLmNoZGlyIGlzIG5vdCBzdXBwb3J0ZWQnKTtcbn07XG5wcm9jZXNzLnVtYXNrID0gZnVuY3Rpb24oKSB7IHJldHVybiAwOyB9O1xuIl19
