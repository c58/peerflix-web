#!/usr/bin/env node

var Hapi = require('hapi');
var Inert = require('inert');
var Boom = require('boom');
var Good = require('good');
var GoodFile = require('good-file');
var GoodConsole = require('good-console');
var GoodSqueeze = require('good-squeeze');
var rimraf = require('rimraf');
var mkdirp = require('mkdirp');
var path = require('path');
var tempDir = require('os').tmpdir();
var readTorrent = require('read-torrent');
var uuid = require('node-uuid');
var fs = require('fs');
var kickass = require('kickass-torrent');
var peerflix = require('peerflix');
var omx = require('omxctrl');

// Configs
var PORT = process.env.PORT || process.argv[2] || 8080;
var LOG_ENABLED = true;

// Params
var connection;
var states = ['PLAYING', 'PAUSED', 'IDLE'];
var omxCtrlMap = {
  'pause': 'pause',
  'speedup': 'increaseSpeed',
  'speeddown': 'decreaseSpeed',
  'nextaudio': 'nextAudioStream',
  'prevaudio': 'previousAudioStream',
  'nextsubtitle': 'nextSubtitleStream',
  'prevsubtitle': 'previousSubtitleStream',
  'togglesubtitle': 'toggleSubtitles',
  'volumeup': 'increaseVolume',
  'volumedown': 'decreaseVolume',
  'forward': 'seekForward',
  'backward': 'seekBackward',
  'fastforward': 'seekFastForward',
  'fastbackward': 'seekFastBackward'
};

// Helper Methods
var clearTorrentCache = function() {
  fs.readdir(tempDir, function(err, files) {
    if (err) {
      console.log(err);
      return;
    }
    files.forEach(function(file) {
      if (file.substr(0, 9) === 'peerflix-') {
        rimraf.sync(path.join(tempDir, file));
      }
    });
  });
};

var stop = function() {
  clearTorrentCache();
  if (!connection) { return; }
  connection.destroy();
  connection = null;
  omx.stop();
};

// Server Setup
var server = new Hapi.Server();
server.connection({ port: PORT, address: '0.0.0.0', host: '0.0.0.0' });
server.register(Inert, () => {});

if (LOG_ENABLED) {
	var options = {};
	var opsPath = path.normalize(__dirname +  '/log/operation');
	var errsPath = path.normalize(__dirname + '/log/error');
	var reqsPath = path.normalize(__dirname + '/log/request');

	options.reporters = {
		consoleReporter: [{
			module: 'good-squeeze',
			name: 'Squeeze',
			args: [{ log: '*', response: '*' }]
		}, {
			module: 'good-console'
		}, 'stdout'],
		opsReporter: [{
			module: 'good-squeeze',
			name: 'Squeeze',
			args: [{ log: '*', ops: '*' }]
		}, {
			module: 'good-squeeze',
			name: 'SafeJson'
		}, {
			module: 'good-file',
			args: [opsPath]
		}],
		errsReporter: [{
			module: 'good-squeeze',
			name: 'Squeeze',
			args: [{ log: '*', error: '*' }]
		}, {
			module: 'good-squeeze',
			name: 'SafeJson'
		}, {
			module: 'good-file',
			args: [errsPath]
		}],
		reqsReporter: [{
			module: 'good-squeeze',
			name: 'Squeeze',
			args: [{ log: '*', response: '*' }]
		}, {
			module: 'good-squeeze',
			name: 'SafeJson'
		}, {
			module: 'good-file',
			args: [reqsPath]
		}]
	};
	server.register({ register: Good, options: options}, function(err) { if (err) { throw(err); } });
}

server.start(function () {
  clearTorrentCache();
  console.log('Peerflix web running at: http://' + server.info.host + ':' + server.info.port);
});

// Routes
server.route({
  method: 'GET',
  path: '/',
  handler: function (request, reply) {
    return reply.file(path.join(__dirname, 'public/index.html'));
  }
});

server.route({
  method: 'GET',
  path: '/assets/{param*}',
  handler: {
    directory: {
      path: path.join(__dirname,'public')
    }
  }
});

server.route({
  method: 'POST',
  path: '/play',
  handler: function (request, reply) {
    var torrentUrl = request.payload.url;
    if (torrentUrl) {
      readTorrent(torrentUrl, function(err, torrent) {
        if (err) { return reply(Boom.badRequest(err)); }
        if (connection) { stop(); }

        connection = peerflix(torrent, {
          connections: 100,
          path: path.join(tempDir, 'peerflix-' + uuid.v4()),
          buffer: (1.5 * 1024 * 1024).toString()
        });

        connection.server.once('error', function() {
					connection.server.listen(0);
				});

        connection.server.on('listening', function() {
          if (!connection) { return reply(Boom.badRequest('Stream was interrupted')); }
          omx.play('http://localhost:' + connection.server.address().port + '/', ['-o', 'alsa', '--blank']);
          return reply({ port: connection.server.address().port });
        });
      });
    }
    else {
      return reply(Boom.badRequest('Torrent URL Required'));
    }
  }
});

server.route({
  method: 'POST',
  path: '/stop',
  handler: function (request, reply) {
    stop();
    return reply();
  }
});

server.route({
  method: 'GET',
  path: '/status',
  handler: function (request, reply) {
  	const status = { status: states[omx.getState()] };

  	if (connection) {
  		Object.assign(status, {
  			downloadSpeed: connection.swarm.downloadSpeed(),
				uploadSpeed: connection.swarm.uploadSpeed(),
				paused: connection.swarm.paused,
				downloaded: connection.swarm.downloaded,
				uploaded: connection.swarm.uploaded,
				name: connection.torrent.name,
				size: connection.torrent.length
  		});
  	}

    return reply(status);
  }
});

server.route({
  method: 'POST',
  path: '/{omx_command}',
  handler: function (request, reply) {
    var omxCommand = request.params.omx_command;
    var actualCommand = omxCtrlMap[omxCommand];
    if (actualCommand) {
      omx[actualCommand]();
      return reply();
    }
    else { return reply(Boom.badRequest('Invalid OMX Player command')); }
  }
});
