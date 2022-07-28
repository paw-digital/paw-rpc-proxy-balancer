var express = require('express');
var fs = require('fs');
var path = require('path');
var http = require('http');
var https = require('https');
var bodyParser = require('body-parser')
var app = express();
var router = express.Router();
var cors = require('cors');
var redis = require('redis');
var posix = require('posix');

// raise maximum number of open file descriptors to 10k,
// hard limit is left unchanged
posix.setrlimit('nofile', { soft: 50000 });

// Listening PORTS for the RPC proxy
var HTTPS_PORT = 7145;
var HTTP_PORT = 7146;
var HTTP_PATH = '/';

// IP addressses of PAW nodes RPC request being forwarded to
var ENDPOINTS_PUBLIC = [{hostname:'127.0.0.1', port:'7046', path: '/'}];
var ENDPOINTS_PRIVATE = [{hostname:'127.0.0.1', port:'7046', path: '/'}];
var ENDPOINTS_HEAVY = [{hostname:'127.0.0.1', port:'7046', path: '/'}];

// CERTIFICATE //
const privateKey = fs.readFileSync('/etc/letsencrypt/live/domainname/privkey.pem', 'utf8');
const certificate = fs.readFileSync('/etc/letsencrypt/live/domainname/cert.pem', 'utf8');
const ca = fs.readFileSync('/etc/letsencrypt/live/domainname/chain.pem', 'utf8');
const credentials = {key: privateKey, cert: certificate, ca: ca};

// Define IP addresses excluded from throttling
var limit_exclusion_ips = [
	"xxx.xxx.xx.xxx" 
];

var public_actions = [
	"accounts_balances",
	"accounts_frontiers",
	"accounts_pending",
	"account_info",
	"account_history",
	"active_difficulty",
	"block_count",
	"block_info",
	"blocks_info",
	"confirmation_history",
	"confirmation_quorum",
	"peers",
	"pending",
	"representatives",
	"representatives_online",
	"uptime",
	"version",
	"delegators"
];
var protected_actions = [
	"process",
];
var protected_heavy_actions = [
	"work_generate"
];

const redisClient = redis.createClient();
redisClient.on('error', err => {
    console.log('Error ' + err);
});
redisClient.connect();


///////////////
// Create an HTTP server

let server = http.createServer(app).listen(HTTP_PORT,function() {
  console.log('Listening HTTP on port ' + HTTP_PORT);
});
server.on('connection', function(socket) {
   console.log("A new connection was made by a client.");
   socket.setTimeout(60 * 1000);
});

// Create HTTPS server
let server_https = https.createServer(credentials, app).listen(HTTPS_PORT,function() {
  console.log('Listening HTTPS on port ' + HTTPS_PORT);
});
server_https.on('connection', function(socket) {
   console.log("A new connection was made by a client.");
   socket.setTimeout(60 * 1000);
});


app.use(cors({
  'allowedHeaders': ['Content-Type', 'DNT', 'X-CustomHeader', 'Access-Control-Allow-Headers', 'User-Agent', 'X-Requested-With', 'If-Modified-Since', 'Cache-Control', 'Content-Type', 'Keep-Alive'], //
  'exposedHeaders': ['sessionId'],
  'origin': '*',
  'methods': 'GET, HEAD, OPTIONS',
  'preflightContinue': false,
  'credentials': true
}));
app.options('*', cors());

// Endpoint for forwarding
router.post(HTTP_PATH, bodyParser.text({
  type: ['json', 'text', 'application/*+json', 'application/x-www-form-urlencoded']
}), async function(req, res) {
	// HANDLE OPTIONS HEADER
	if (req.method == "OPTIONS") {
		console.log('OPTIONS');
		res.setHeader('Access-Control-Allow-Origin', '*');
		res.setHeader('Access-Control-Allow-Credentials', 'true');
		res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
		res.setHeader('Access-Control-Allow-Headers', 'DNT,X-CustomHeader,User-Agent,X-Requested-With,If-Modified-Since,Cache-Control,Content-Type,Keep-Alive');//
		res.send('');
		return
	}

	// PARSE REQUEST
	try
	{
		body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
	}
	catch (e) {
		console.log(e);
		res.send('{"result": "error"}');
		return;
	}
	
	// THROTTLING
	const unixTime = Math.floor(Date.now() / 1000);
	let ip = typeof(req.headers['x-forwarded-for']) != 'undefined' ? req.headers['x-forwarded-for'] : req.connection.remoteAddress;
	
	if(limit_exclusion_ips.indexOf(ip) == -1)
	{
		let throttle30 = {'requests' : 0, 'started' : unixTime};
		let throttle24hrs = {'requests' : 0, 'started' : unixTime};
		
		let cache = await redisClient.get('throttle:30min:['+ip+']');
		if(cache != null && JSON.parse(cache).started > (unixTime - 60*30))
			throttle30 = JSON.parse(cache);
			
		cache = await redisClient.get('throttle:24hrs:['+ip+']');
		if(cache != null && JSON.parse(cache).started > (unixTime - 60*60*24))
			throttle24hrs = JSON.parse(cache);
		
			
		if(throttle30.requests > 30)
		{
			console.log(`${ip} - WORK LIMIT REACHED`)
			res.send('{"result": "error", "error":"too many requests, consider using your own node"}');
			return;
		}
		if(throttle24hrs.requests > 600)
		{
			console.log(`${ip} - WORK LIMIT REACHED`)
			res.send('{"result": "error", "error":"too many requests, consider using your own node"}');
			return;
		}
		
		if(protected_actions.indexOf(body.action) != -1)
		{
			throttle30.requests += 1;
			throttle24hrs.requests += 1;
		}
			
		redisClient.set('throttle:30min:['+ip+']', JSON.stringify(throttle30), 'EX', 60 * 60 * 24);
		redisClient.set('throttle:24hrs:['+ip+']', JSON.stringify(throttle24hrs), 'EX', 60 * 60 * 24);
	}

	// MAKE REQUEST
	try {
		res.setHeader('Access-Control-Allow-Origin', '*');
		res.setHeader('Access-Control-Allow-Credentials', 'true');
		res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
		res.setHeader('Access-Control-Allow-Headers', 'DNT,X-CustomHeader,User-Agent,X-Requested-With,If-Modified-Since,Cache-Control,Content-Type,Keep-Alive'); //,Keep-Alive
		res.setHeader('Content-Type', 'application/json');
	}
	catch (e) {
		console.log(e);
	}
		
	try {
		sendRequestToOtherEndPoints(res, body, ip);
	}
	catch (e) {
		console.log(e);
		res.send('{"result": "error"}');
		return;
	}
	
});
app.use(router);

function sendRequestToOtherEndPoints(userEp, data, ip){
	
	// Get the EP
	var ep = false; 
	if(public_actions.indexOf(data.action) != -1)
	{
		ep = ENDPOINTS_PUBLIC[Math.floor(Math.random()*ENDPOINTS_PUBLIC.length)];
	}
	else if(protected_actions.indexOf(data.action) != -1)
	{
		ep = ENDPOINTS_PRIVATE[Math.floor(Math.random()*ENDPOINTS_PRIVATE.length)];
	}
	else if(protected_heavy_actions.indexOf(data.action) != -1)
	{
		ep = ENDPOINTS_HEAVY[Math.floor(Math.random()*ENDPOINTS_HEAVY.length)];
	}
	else
	{
		userEp.send('{"result": "error", "error": "unsupported action"}');
		return;
	}
		
	// Forward request
	var options = {
		hostname: ep.hostname,
		port: ep.port,
		path: ep.path,
		method: 'POST',
		timeout: 60000
	}
	var request = http.request(options, result => {
		console.log(`${ip} - statusCode: ${result.statusCode}`)

		var data = '';
		result.on('data', chunk => {
			data += chunk;
		})
		result.on('end', () => {
			try
			{
				userEp.send(data);
			}
			catch(e)
			{
				console.log(e);
			}
		});
	});
	request.on('timeout', function() {
		console.log(ip + ' - timeout (EP: ' + ep + ')' + JSON.stringify(data))
		sendRequestToOtherEndPoints(userEp, data, ip);
	});
	request.on('error', function(e) {
		console.log('problem with request: ' + e.message);
	});
	request.write(JSON.stringify(data));
	request.end();
}
