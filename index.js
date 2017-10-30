// jshint esversion: 6, globalstrict: true, strict: true
'use strict';

const CP = require('child_process');
const P2P = require('pipe2pam');
const PD = require('pam-diff');
const spawn = CP.spawn;
const exec = CP.exec;
const fs = require('fs');

//change this to /dev/shm/manifest.m3u8
const pathToHLS = "/dev/shm/manifest.m3u8";//should be in /dev/shm/manifest.m3u8 to write files in memory and not on disc
//increase milliseconds to record longer videos after motion detected
const timeout = 10000;//10000 = 10 seconds of recorded video, includes buffer of time before motion triggered recording
//set the directory for the jpegs and mp4 videos to be saved
const pathToRecordings = "/mnt/data/recordings";

if (fs.existsSync(pathToRecordings) !== true) {
    const msg = `${pathToRecordings} does not exist`;
    throw new Error(msg);
}

let recordingStopper = null;//timer used to finish the mp4 recording with sigint after enough time passed with no additional motion events
let motionRecorder = null;//placeholder for spawned ffmpeg process that will record video to disc
let bufferReady = false;//flag to allow time for video source to create manifest.m3u8

exec(`cd ${pathToRecordings} && python -m SimpleHTTPServer 80`, (error, stdout, stderr) => {
    if (error) {
        console.error(`exec error: ${error}`);
        return;
    }
    console.log(`stdout: ${stdout}`);
    console.log(`stderr: ${stderr}`);
});

function setTimeoutCallback() {
    if (motionRecorder && motionRecorder.kill(0)) {
        motionRecorder.kill();
        motionRecorder = null;
        recordingStopper = null;
    }
    console.log('recording finished');
}

const params = [
    '-loglevel',
    'quiet',

    /* use hardware acceleration */
    '-hwaccel',
    'auto',//vda, videotoolbox, none, auto

    /* use an rtsp ip cam video input */
    '-rtsp_transport',
    'tcp',
    '-i',
    'rtsp://192.168.1.4:554/user=admin_password=pass_channel=1_stream=0.sdp',

    /* output hls video that will used as source for recording when motion triggered */
    '-an',
    '-c:v',
    'copy',
    '-f',
    'hls',
    '-hls_time',
    '1',
    '-hls_list_size',
    '2',
    '-start_number',
    '0',
    '-hls_allow_cache',
    '0',
    '-hls_flags',
    '+delete_segments+omit_endlist',
    pathToHLS,

    /* output pam image that is used as source for motion detection analysis */
    '-an',
    '-c:v',
    'pam',
    '-pix_fmt',
    //'gray',
    'rgb24',
    '-f',
    'image2pipe',
    '-vf',
    'fps=2,scale=640:360',
    //'-frames',
    //'1000',
    'pipe:1'
];

const regions = [
    {name: 'region1', difference: 10, percent: 11, polygon: [{x: 0, y: 0}, {x: 0, y:360}, {x: 160, y: 360}, {x: 160, y: 0}]},
    {name: 'region2', difference: 10, percent: 11, polygon: [{x: 160, y: 0}, {x: 160, y: 360}, {x: 320, y: 360}, {x: 320, y: 0}]},
    {name: 'region3', difference: 10, percent: 11, polygon: [{x: 320, y: 0}, {x: 320, y: 360}, {x: 480, y: 360}, {x: 480, y: 0}]},
    {name: 'region4', difference: 10, percent: 11, polygon: [{x: 480, y: 0}, {x: 480, y: 360}, {x: 640, y: 360}, {x: 640, y: 0}]}
];

const p2p = new P2P();
p2p.on('pam', (data) => {
    //console.log(data);
    console.log('frame');
});

const pd = new PD({grayscale: 'luminosity', regions : regions})
    .on('diff', (data) => {
        //wait just a moment to give ffmpeg a chance to write manifest.mpd
        if (bufferReady === false) {
            bufferReady = true;
            return;
        }
        if (recordingStopper === null) {
            const date = new Date();
            let name = `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}_${('0'+date.getHours()).substr(-2)}-${('0'+date.getMinutes()).substr(-2)}-${('0'+date.getSeconds()).substr(-2)}-${('00'+date.getMilliseconds()).substr(-3)}`;
            for (const region of data.trigger) {
                name += `_${region.name}-${region.percent}_`;
            }
            const jpeg = `${name}.jpeg`;
            const jpegPath = `${pathToRecordings}/${jpeg}`;
            console.log(jpegPath);
            const mp4 = `${name}.mp4`;
            const mp4Path = `${pathToRecordings}/${mp4}`;
            console.log(mp4Path);
            motionRecorder = spawn('ffmpeg', ['-loglevel', 'quiet', '-f', 'pam_pipe', '-c:v', 'pam', '-i', 'pipe:0', '-re', '-i', pathToHLS, '-map', '1:v', '-an', '-c:v', 'copy', '-movflags', '+faststart+empty_moov', mp4Path, '-map', '0:v', '-c:v', 'mjpeg', '-pix_fmt', 'yuvj422p', '-q:v', '1', '-huffman', 'optimal', jpegPath], {stdio: ['pipe', 'pipe', 'ignore']})
                .on('error', (error) => {console.log(error);})
                .on('exit', (code, signal) => {
                    if (code !== 0 && code !== 255) {
                        console.log('motionRecorder', motionRecorder.spawnargs.join(' '), code, signal);                    }
                });
            motionRecorder.stdin.end(data.pam);
            recordingStopper = setTimeout(setTimeoutCallback, timeout);
            console.log(`recording started for video ${mp4}`);
        } else {
            console.log(`due to continued motion, recording has been extended by ${timeout/1000} seconds from now`);
            clearTimeout(recordingStopper);
            recordingStopper = setTimeout(setTimeoutCallback, timeout);
        }
    });

const videoSource = spawn('ffmpeg', params, {stdio: ['ignore', 'pipe', 'ignore']})
    .on('error', (error) => {console.log(error);})
    .on('exit', (code, signal) => {console.log('exit', code, signal);});

videoSource.stdout.pipe(p2p).pipe(pd);