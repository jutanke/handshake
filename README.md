# Handshake.js

Simple library to initiate a WebRTC handshake between peers.
To exchange the Handshake, some sort of signaling is needed.

## Alice
```javascript
// A create an offer..
var peer = Handshake.createOffer(function(offer){
    // we need to send {offer} to Bob
    ...
});


...
// C apply the others answer..
Handshake.handleAnswer(peer, ANSWER_FROM_BOB);

// API

// get own address
var ownAddress = Handshake.address();

peer.onopen(function(){
    // we can send data now!
    peer.send("Hello World");
    
    // ask the peer for all its current neighbors
    peer.getNeighbors()
        .then(function(neighbors){
            console.log(neighbors); // ["Address1", "Address2", ...]
        })
        .catch(function(){
            // something went wrong.. timeout or so..
        });
 
    ...
    
    // ask the peer to host a connection to another peer it is connected to
    var otherPeer = peer.attemptToConnect("address1");
    
    otherPeer.onopen(function(){
        ...
    });
    
    // gets called when the attempt to connect did not succeed.
    otherPeer.oncannotfindpeer(function(addr){
        ...
    });
});

peer.onmessage(function(msg){
    console.log(msg);
});

...

// callback for connections from within the network
Handshake.onRemoteConnection(function(peer){
    peer.onopen(function(){
        ...
    });
});

```

## Bob
```javascript
// B answer to the offer..
var peer = Handshake.createAnswer(function(answer){
    // we need to send {answer} back to Alice
    ...
});

// API

peer.onopen(function(){
    // we can send data now!
    peer.send("Hello World back");
});

peer.onmessage(function(msg){
    console.log(msg);
});

```