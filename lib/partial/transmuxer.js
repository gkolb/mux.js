var Stream = require('../utils/stream.js');
var m2ts = require('../m2ts/m2ts.js');
var codecs = require('../codecs/index.js');
var AudioSegmentStream = require('./audio-segment-stream.js');
var VideoSegmentStream = require('./video-segment-stream.js');
var trackInfo = require('../mp4/track-decode-info.js');
var isLikelyAacData = require('../aac/utils').isLikelyAacData;
var AdtsStream = require('./adts-stream');
var AacStream = require('./aac-stream');
var clock = require('../utils/clock');

var createPipeline = function(object) {
  object.prototype = new Stream();
  object.prototype.init.call(object);

  return object;
};

var tsPipeline = function(options) {
  var
    pipeline = {
    type: 'ts',
    tracks: {
      audio: null,
      video: null
    },
    packet: new m2ts.TransportPacketStream(),
    parse: new m2ts.TransportParseStream(),
    elementary: new m2ts.ElementaryStream(),
    videoRollover: new m2ts.TimestampRolloverStream('video'),
    audioRollover: new m2ts.TimestampRolloverStream('audio'),
    adts: new codecs.adts(),
    h264: new codecs.h264.H264Stream(),
    // captionStream: new m2ts.CaptionStream(),
    metadataStream: new m2ts.MetadataStream(),
    timedMetadataTimestampRolloverStream:
      new m2ts.TimestampRolloverStream('timed-metadata')
  };

  pipeline.headOfPipeline = pipeline.packet;

  // Transport Stream
  pipeline.packet
    .pipe(pipeline.parse)
    .pipe(pipeline.elementary);

  // H264
  pipeline.elementary
    .pipe(pipeline.videoRollover)
    .pipe(pipeline.h264);

  // Hook up CEA-608/708 caption stream
  // pipeline.h264Stream
  //  .pipe(pipeline.captionStream)

  pipeline.elementary
    .pipe(pipeline.timedMetadataTimestampRolloverStream)
    .pipe(pipeline.metadataStream);

  // ADTS
  pipeline.elementary
    .pipe(pipeline.audioRollover)
    .pipe(pipeline.adts);

  pipeline.elementary.on('data', function(data) {
    if (data.type !== 'metadata') {
      return;
    }

    for (var i = 0; i < data.tracks.length; i++) {
      if (!pipeline.tracks[data.tracks[i].type]) {
        pipeline.tracks[data.tracks[i].type] = data.tracks[i];
      }
    }

    if (pipeline.tracks.video && !pipeline.videoSegmentStream) {
      pipeline.videoSegmentStream = new VideoSegmentStream(pipeline.tracks.video, options);

      pipeline.videoSegmentStream.on('timelineStartInfo', function(timelineStartInfo) {
        if (pipeline.tracks.audio) {
          pipeline.audioSegmentStream.setEarliestDts(timelineStartInfo);
        }
      });

      pipeline.videoSegmentStream.on('timingInfo',
                                     pipeline.trigger.bind(pipeline, 'videoTimingInfo'));

      pipeline.videoSegmentStream.on('data', function(data) {
        pipeline.trigger('data', {
          type: 'video',
          data: data
        });
      });

      pipeline.videoSegmentStream.on('done',
                                     pipeline.trigger.bind(pipeline, 'done'));
      pipeline.videoSegmentStream.on('partialdone',
                                     pipeline.trigger.bind(pipeline, 'partialdone'));
      pipeline.videoSegmentStream.on('endedtimeline',
                                     pipeline.trigger.bind(pipeline, 'endedtimeline'));

      pipeline.h264
        .pipe(pipeline.videoSegmentStream);
    }

    if (pipeline.tracks.audio && !pipeline.audioSegmentStream) {
      pipeline.audioSegmentStream = new AudioSegmentStream(pipeline.tracks.audio, options);

      pipeline.audioSegmentStream.on('data', function(data) {
        pipeline.trigger('data', {
          type: 'audio',
          data: data
        });
      });

      pipeline.audioSegmentStream.on('done',
                                     pipeline.trigger.bind(pipeline, 'done'));
      pipeline.videoSegmentStream.on('partialdone',
                                     pipeline.trigger.bind(pipeline, 'partialdone'));
      pipeline.audioSegmentStream.on('endedtimeline',
                                     pipeline.trigger.bind(pipeline, 'endedtimeline'));

      pipeline.audioSegmentStream.on('timingInfo',
                                     pipeline.trigger.bind(pipeline, 'audioTimingInfo'));

      pipeline.adts
        .pipe(pipeline.audioSegmentStream);
    }

    // emit pmt info
    pipeline.trigger('trackinfo', {
      hasAudio: !!pipeline.tracks.audio,
      hasVideo: !!pipeline.tracks.video
    });
  });

  /*
  pipeline.captionStream.on('data', function(data) {
    // TODO
    pendingCaptions.push(data);
  });

  pipeline.captionStream.on('flush', function() {
    // Translate caption PTS times into second offsets into the
    // video timeline for the segment, and add track info
    for (i = 0; i < this.pendingCaptions.length; i++) {
      caption = this.pendingCaptions[i];
      caption.startTime = (caption.startPts - timelineStartPts);
      caption.startTime /= 90e3;
      caption.endTime = (caption.endPts - timelineStartPts);
      caption.endTime /= 90e3;
      event.captionStreams[caption.stream] = true;
      event.captions.push(caption);
    }
  });
  */

  pipeline = createPipeline(pipeline);

  pipeline.metadataStream.on('data', pipeline.trigger.bind(pipeline, 'id3Frame'));

  return pipeline;
};

var aacPipeline = function(options) {
  var
    pipeline = {
    type: 'aac',
    tracks: {
      audio: {
        timelineStartInfo: {
          baseMediaDecodeTime: options.baseMediaDecodeTime
        }
      }
    },
    metadataStream: new m2ts.MetadataStream(),
    aacStream: new AacStream(),
    audioRollover: new m2ts.TimestampRolloverStream('audio'),
    timedMetadataTimestampRolloverStream:
      new m2ts.TimestampRolloverStream('timed-metadata'),
    adtsStream: new AdtsStream()
  };

  // set up the parsing pipeline
  pipeline.headOfPipeline = pipeline.aacStream;

  pipeline.aacStream
    .pipe(pipeline.audioRollover)
    .pipe(pipeline.adtsStream);
  pipeline.aacStream
    .pipe(pipeline.timedMetadataTimestampRolloverStream)
    .pipe(pipeline.metadataStream);

  pipeline.metadataStream.on('timestamp', function(frame) {
    pipeline.aacStream.setTimestamp(frame.timeStamp);
  });

  pipeline.metadataStream.on('data', pipeline.trigger.bind(pipeline, 'id3Frame'));

  pipeline.aacStream.on('data', function(data) {
    if (data.type !== 'timed-metadata' || pipeline.audioSegmentStream) {
      return;
    }

    var audioTrack = {
      timelineStartInfo: {
        baseMediaDecodeTime: pipeline.tracks.audio.timelineStartInfo.baseMediaDecodeTime
      },
      codec: 'adts',
      type: 'audio'
    };

    // hook up the audio segment stream to the first track with aac data
    pipeline.audioSegmentStream = new AudioSegmentStream(audioTrack, options);

    pipeline.audioSegmentStream.on('timingInfo',
      pipeline.trigger.bind(pipeline, 'audioTimingInfo'));

    // Set up the final part of the audio pipeline
    pipeline.adtsStream
      .pipe(pipeline.audioSegmentStream)

    pipeline.audioSegmentStream.on('data', function(data) {
      pipeline.trigger('data', {
        type: 'audio',
        data: data
      });
    });
    pipeline.audioSegmentStream.on('partialdone',
                                   pipeline.trigger.bind(pipeline, 'partialdone'));
    pipeline.audioSegmentStream.on('done', pipeline.trigger.bind(pipeline, 'done'));
    pipeline.audioSegmentStream.on('endedtimeline',
                                   pipeline.trigger.bind(pipeline, 'endedtimeline'));
    pipeline.audioSegmentStream.on('timingInfo',
                                   pipeline.trigger.bind(pipeline, 'audioTimingInfo'));

  });

  return createPipeline(pipeline);
};

var setupPipelineListeners = function(pipeline, transmuxer) {
  pipeline.on('data', transmuxer.trigger.bind(transmuxer, 'data'));
  pipeline.on('done', transmuxer.trigger.bind(transmuxer, 'done'));
  pipeline.on('partialdone', transmuxer.trigger.bind(transmuxer, 'partialdone'));
  pipeline.on('endedtimeline', transmuxer.trigger.bind(transmuxer, 'endedtimeline'));
  pipeline.on('audioTimingInfo', transmuxer.trigger.bind(transmuxer, 'audioTimingInfo'));
  pipeline.on('videoTimingInfo', transmuxer.trigger.bind(transmuxer, 'videoTimingInfo'));
  pipeline.on('trackinfo', transmuxer.trigger.bind(transmuxer, 'trackinfo'));
  pipeline.on('id3Frame', (event) => {
    // add this to every single emitted segment even though it's only needed for the first
    event.dispatchType = pipeline.metadataStream.dispatchType;
    // keep original time, can be adjusted if needed at a higher level
    event.cueTime = clock.videoTsToSeconds(event.pts);

    transmuxer.trigger('id3Frame', event);
  });
};

var Transmuxer = function(options) {
  var
    pipeline = null,
    hasFlushed = true;

  Transmuxer.prototype.init.call(this);

  this.push = function(bytes) {
    if (hasFlushed) {
      var isAac = isLikelyAacData(bytes);

      if (isAac && (!pipeline || pipeline.type !== 'aac')) {
        pipeline = aacPipeline(options);
        setupPipelineListeners(pipeline, this);
      } else if (!isAac && (!pipeline || pipeline.type !== 'ts')) {
        pipeline = tsPipeline(options);
        setupPipelineListeners(pipeline, this);
      }
      hasFlushed = false;
    }

    pipeline.headOfPipeline.push(bytes);
  };

  this.flush = function() {
    if (!pipeline) {
      return;
    }

    hasFlushed = true;
    pipeline.headOfPipeline.flush();
  };

  this.partialFlush = function() {
    if (!pipeline) {
      return;
    }

    pipeline.headOfPipeline.partialFlush();
  };

  this.endTimeline = function() {
    if (!pipeline) {
      return;
    }

    pipeline.headOfPipeline.endTimeline();
  };

  this.reset = function() {
    if (!pipeline) {
      return;
    }

    pipeline.headOfPipeline.reset();
  };

  this.setBaseMediaDecodeTime = function(baseMediaDecodeTime) {
    options.baseMediaDecodeTime = baseMediaDecodeTime;

    if (!pipeline) {
      return;
    }

    if (pipeline.tracks.audio) {
      pipeline.tracks.audio.timelineStartInfo.dts = undefined;
      pipeline.tracks.audio.timelineStartInfo.pts = undefined;
      trackInfo.clearDtsInfo(pipeline.tracks.audio);
      if (!options.keepOriginalTimestamps) {
        pipeline.tracks.audio.timelineStartInfo.baseMediaDecodeTime = baseMediaDecodeTime;
      }
      if (pipeline.audioRollover) {
        pipeline.audioRollover.discontinuity();
      }
    }
    if (pipeline.tracks.video) {
      if (pipeline.videoSegmentStream) {
        pipeline.videoSegmentStream.gopCache_ = [];
        pipeline.videoRollover.discontinuity();
      }
      pipeline.tracks.video.timelineStartInfo.dts = undefined;
      pipeline.tracks.video.timelineStartInfo.pts = undefined;
      trackInfo.clearDtsInfo(pipeline.tracks.video);
      // pipeline.captionStream.reset();
      if (!options.keepOriginalTimestamps) {
        pipeline.tracks.video.timelineStartInfo.baseMediaDecodeTime = baseMediaDecodeTime;
      }
    }
  };

  this.setAudioAppendStart = function(audioAppendStart) {
    if (!pipeline || !pipeline.tracks.audio || !pipeline.audioSegmentStream) {
      return;
    }

    pipeline.audioSegmentStream.setAudioAppendStart(audioAppendStart);
  };

  // TODO
  this.alignGopsWith = function(gopsToAlignWith) {
    if (!pipeline || !pipeline.videoSegmentStream) {
      return;
    }

    // pipeline.videoSegmentStream.alignGopsWith(gopsToAlignWith);
  };
};

Transmuxer.prototype = new Stream();

module.exports = Transmuxer;