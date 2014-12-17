/**
 * Created by Julian on 12/11/2014.
 */
var Utils = require("yutils");
var Peer = require("./Peer.js").Peer;
var PeerCache = require("./PeerCache.js").PeerCache;
var MESSAGE_TYPE = require("./MESSAGE_TYPE.js");
//var ADDRESS = Utils.guid(); // pseudo-unique
var ADDRESS = require("./Address").LocalAddress;

var onRemoteConnectionCallbacks = [];

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
        var i, L, newPeer, destinationPeer;
        switch (msg.type) {
            case MESSAGE_TYPE.OFFER:
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
                peer.address = msg.payload;
                i = 0, L = peer.onOpen.length;
                PeerCache.put(peer);
                for(;i<L;i++) {
                    peer.onOpen[i].call(peer);
                }
                peer.onOpen = null;
                break;
            case MESSAGE_TYPE.MESSAGE:
                i = 0, L = peer.onMessage.length;
                for(;i<L;i++) {
                    peer.onMessage[i].call(peer, msg.payload);
                }
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

/* ====================================
 EXPORT
 ==================================== */
exports.createOffer = createOffer;
exports.handleAnswer = handleAnswer;
exports.createAnswer = createAnswer;
exports.onRemoteConnection = onRemoteConnection;
exports.address = function () {
    return ADDRESS;
};