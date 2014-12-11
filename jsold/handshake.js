window.guid=function(){"performance"in window||(window.performance={});var a=window.performance;window.performance.now=a.now||a.mozNow||a.msNow||a.oNow||a.webkitNow||Date.now||function(){return(new Date).getTime()};return function(){var a=performance.now();return"xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g,function(c){var b=(a+16*Math.random())%16|0;a=Math.floor(a/16);return("x"===c?b:b&3|8).toString(16)})}}();

/**
 * Created by Julian on 11/22/2014.
 */
window.Handshake = (function () {

    var ICE_CONFIG = {"iceServers":[{"url":"stun:23.21.150.121"}]};
    var CONN = { 'optional': [{'DtlsSrtpKeyAgreement': true}] };
    var ADDRESS = guid(); // pseudounique

    function isString(myVar) {
        return (typeof myVar === 'string' || myVar instanceof String)
    }

    var MESSAGE_TYPE = {
        MESSAGE : 0|0,
        TELL_ADDRESS: 1|0,
        GET_NEIGHBORS : 2|0
    }

    function Peer() {
        var pc = new RTCPeerConnection(ICE_CONFIG, CONN);
        this.pc = pc;
        this.address = null;
        this.dc = null;
        this.onOpen = [];
        this.onMessage = [];
        this.onDisconnect = [];
        this.offerCallback = null;
        this.createCallback = null;
        this.iceTimeout = null;
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

        pc.onpeeridentity = function (e) {
            console.log("peer ident:",e);
        }

        pc.onsignalingstatechange = function(ev) {
            console.log("onsignalingstatechange event detected!", ev);
        };
    }

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

    Peer.prototype.send = function (message) {
        if (this.dc === null || this.dc.readyState !== "open") {
            throw new Error("Handshake incomplete! Sending is not possible.");
        }
        this.dc.send(JSON.stringify({type: MESSAGE_TYPE.MESSAGE, payload:message }));
    };




    /* ====================================
                A P I
     ==================================== */

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

    function handleMessage(peer) {
        return function (e) {
            var msg = isString(e.data) ? JSON.parse(e.data) : e.data;
            var i,L;
            switch (msg.type) {
                case MESSAGE_TYPE.GET_NEIGHBORS:
                    break;
                case MESSAGE_TYPE.TELL_ADDRESS:
                    peer.address = msg.payload;
                    i = 0, L = peer.onOpen.length;
                    for(;i<L;i++) {
                        peer.onOpen[i].call(peer);
                    }
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

    function handleAnswer(peer, answer) {
        var answerDesc = new RTCSessionDescription(JSON.parse(answer));
        peer.pc.setRemoteDescription(answerDesc);
    }

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

    /* ====================================
                A P I
     ==================================== */

    return {
        createOffer: createOffer,
        handleAnswer: handleAnswer,
        createAnswer: createAnswer,

        address : function () {
            return ADDRESS;
        }

    };

})();