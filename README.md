# paw-rpc-proxy-balancer

Acts as a proxy and forwards RPC requests to a node. Multiple nodes can be added and it will pick one at random and forward the request. 

# Prerequisite
Redis server with redis-cli

# Setup
npm install

Update the config variables in rpc_forwarder.js and point to a local certificate.

Run ./start.sh
