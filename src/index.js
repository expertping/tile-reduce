'use strict';

module.exports = tileReduce;

const EventEmitter = require('events').EventEmitter;
const cpus = require('os').cpus().length;
const fork = require('child_process').fork;
const path = require('path');
const binarysplit = require('binary-split');
const cover = require('./cover');
const streamArray = require('stream-array');
const MBTiles = require('mbtiles');
const through = require('through2');

function tileReduce(options) {

  const ee = new EventEmitter();
  const workers = ee.workers = [];
  const pauseLimit = options.batch || 5000;
  const start = Date.now();
  const output = options.output || process.stdout;

  let workersReady = 0;
  let tileStream = null;
  let tilesDone = 0;
  let tilesSent = 0;
  let timer;

  if (options.tileStream) {
    // Pass through a dummy pipe. This ensures the stream is in the proper mode.
    // See last paragraph of the 'classic readable streams' section at
    // https://github.com/substack/stream-handbook#classic-readable-streams
    options.tileStream = options.tileStream.pipe(through.obj());
  }
  const maxWorkers = Math.min(cpus, options.maxWorkers || cpus);
  log('Starting up ' + maxWorkers + ' workers... ');

  // Suppress max listener warnings. We need at least 1 listener per worker.
  process.stderr.setMaxListeners(0);
  output.setMaxListeners(0);

  for (let i = 0; i < maxWorkers; i++) {
    const worker = fork(path.join(__dirname, 'worker.js'), [options.map, JSON.stringify(options.sources)], {silent: true});
    worker.stdout.pipe(binarysplit('\x1e')).pipe(output);
    worker.stderr.pipe(process.stderr);
    worker.on('message', handleMessage);
    workers.push(worker);
  }

  function handleMessage(message) {
    if (message.reduce) reduce(message.value, message.tile);
    else if (message.ready && ++workersReady === workers.length) run();
  }

  function run() {
    log('Job started.\n');

    ee.emit('start');
    timer = setInterval(updateStatus, 64);

    var tiles = cover(options);

    if (tiles) {
      // JS tile array, GeoJSON or bbox
      log('Processing ' + tiles.length + ' tiles.\n');
      tileStream = streamArray(tiles)
        .on('data', handleTile)
        .on('end', streamEnded);

    } else if (options.tileStream) {
      log('Processing tile coords from tile stream.\n');
      tileStream = options.tileStream;
      tileStream
        .on('data', handleTileStreamLine)
        .on('end', streamEnded)
        .resume();
    } else {
      // try to get tiles from mbtiles (either specified by sourceCover or first encountered)
      let source;
      for (source of options.sources) {
        if (source.mbtiles && (!options.sourceCover || options.sourceCover === source.name)) break;
        source = null;
      }
      if (source) {
        log('Processing tile coords from "' + source.name + '" source.\n');
        var db = new MBTiles(source.mbtiles, (err) => {
          if (err) throw err;
          tileStream = db.createZXYStream()
            .pipe(binarysplit('\n'))
            .on('data', handleZXYLine)
            .on('end', streamEnded);
        });

      } else {
        throw new Error(options.sourceCover ?
          'Specified source for cover not found.' :
          'No area or tiles specified for the job.');
      }
    }
  }

  var paused = false;
  var ended = false;

  function streamEnded() {
    ended = true;
  }

  function handleTile(tile) {
    var workerId = tilesSent++ % workers.length;
    ee.emit('map', tile, workerId);
    workers[workerId].send(tile);
    if (!paused && tilesSent - tilesDone > pauseLimit) {
      paused = true;
      tileStream.pause();
    }
  }

  function handleTileStreamLine(line) {
    var tile = line;
    if (typeof line === 'string' || line instanceof Buffer) {
      tile = line.toString().split(' ');
    }
    handleTile(tile.map(Number));
  }

  function handleZXYLine(line) {
    var tile = line.toString().split('/');
    handleTile([+tile[1], +tile[2], +tile[0]]);
  }

  function reduce(value, tile) {
    if (value !== null && value !== undefined) ee.emit('reduce', value, tile);
    if (paused && tilesSent - tilesDone < (pauseLimit / 2)) {
      paused = false;
      tileStream.resume();
    }
    if (++tilesDone === tilesSent && ended) shutdown();
  }

  function shutdown() {
    while (workers.length) workers.pop().kill();

    clearTimeout(timer);
    updateStatus();
    log('.\n');

    ee.emit('end');
  }

  /* istanbul ignore next */
  function updateStatus() {
    if (options.log === false || !process.stderr.cursorTo) return;

    var s = Math.floor((Date.now() - start) / 1000);
    var h = Math.floor(s / 3600);
    var m = Math.floor((s - h * 3600) / 60);
    var time = (h ? h + 'h ' : '') + (h || m ? m + 'm ' : '') + (s % 60) + 's';

    process.stderr.cursorTo(0);
    process.stderr.write(tilesDone + ' tiles processed in ' + time);
    process.stderr.clearLine(1);
  }

  /* istanbul ignore next */
  function log(str) {
    if (options.log !== false) process.stderr.write(str);
  }

  return ee;
}
