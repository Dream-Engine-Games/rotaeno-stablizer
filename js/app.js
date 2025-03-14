const Lock = function() {
    const queue = [];
    let locked = false;

    this.acquire = function() {
        if (!locked) {
            locked = true;
            return Promise.resolve();
        }

        let r = new Promise(r => {
            queue.push(r);
        });

        return r.then(() => {
            locked = true;
        });
    };
    this.release = function() {
        locked = false;
        if (queue.length)
            (queue.shift())();
    };
};

window.onload = async function() {
    const translations = {
        'zh-CN': {
            compatabilityWarning: '此浏览器过旧或缺少必须功能',
            workerDegradation: '当前环境不支持Web Worker多线程模式，性能可能受影响',
            encodeDoneMessage: '编码已完成',
        },
        'en': {
            compatabilityWarning: 'This browser is too old or lacking features.',
            workerDegradation: 'Web Worker is not supported, expect poor performance.',
            encodeDoneMessage: 'Encoding completed',

            analyzeBtn: 'Auto Configure',
            videoTrimInstruction: 'Set the start point and end point in the video.',
            trimStart: 'Start',
            trimEnd: 'End',
            orientation: 'Orientation',
            oUpright: 'Upright',
            oLeft: 'Left',
            oRight: 'Right',
            cropInstruction: 'Adjust cropping to align the red line with outer edge of game capture, or click ',
            cropL: 'Left',
            cropT: 'Top',
            cropR: 'Right',
            cropB: 'Bottom',
            blockSizeInstruction: 'Adjust size to align the green line with edge of the color blocks.<br>It\'s recommended to seek to a position where one of the blocks is showing yellow or white.',
            sensitivity: 'Sensitivity',
            threshold: 'Threshold',
            seekPosition: 'Seek',
            blockSize: 'Size',
            backgroundRingInstruction: 'To disable the addition of the circle in the background, set radius to 0.',
            ringRadius: 'Radius',
            ringStroke: 'Width',
            btnNextStep: 'Next',
            encodeReadyMsg: 'Click "Next" to start encoding.',
            outputDim: 'Resolution',
            outputCodec: 'Codec',
            outputBitrate: 'Bitrate',
            keyInterval: 'Keyframe Interval',
            encodingMsg: 'Encoding in progress. Please keep this page open if using a mobile device. Once done, click the link to ',
            download: 'Download',
            credit1: '<span style="font-weight: bold; color: yellow">Streaming Mode</span> and <span style="font-weight: bold; color: yellow">Stream Encoding V2</span> must be enabled in game settings.',
            credit2: 'All processing is done locally, no data will be uploaded.',
            credit3: 'Powered by <a href="https://github.com/Yahweasel/libav.js">libav</a>.<a href="https://github.com/Yahweasel/libavjs-webcodecs-bridge">js</a>',
        }
    };

    let translation = translations.en;
    for (const language of navigator.languages) {
        let trans = translations[language] ?? translations[language.split('-')[0]];
        if (trans) {
            translation = trans;
            for (const key in translation) {
                let element = document.getElementById(key);
                element = (element?.labels?.[0] ?? element);
                if (element) {
                    element.innerHTML = translation[key];
                }
            }
            break;
        }
    }

    const featureCheck = {
        secureContext: () => isSecureContext,
        resizableArrayBuffer: () => new ArrayBuffer(0, {maxByteLength: 1024}).resize(1024) || true,
        webCodecs: () => VideoEncoder && VideoDecoder,
        offscreenCanvas: () => new OffscreenCanvas(16, 16).getContext('2d'),
        notTbsBrowser: () => navigator.userAgent.indexOf(' TBS/') < 0,
    };
    let failedChecks = []
    for (const feature in featureCheck) {
        try {
            if(featureCheck[feature]()) continue;
        } catch {}
        failedChecks.push(feature);
    }

    if (failedChecks.length)
        alert(translation.compatabilityWarning + ' ' + failedChecks.join(', '));

    const libav = await LibAV.LibAV({noworker: true, nowasm: true});
    const avpPkt = libav.av_packet_alloc_sync();
    const avpPktW = libav.av_packet_alloc_sync();

    /** @type HTMLCanvasElement */
    const previewCanvas = document.getElementById('preview');

    /** @typedef PtrAVFormatContext number */
    /** @type PtrAVFormatContext */
    let inCtx;
    /** @type Stream */
    let ivStream, iaStream;
    /** @type VideoDecoderConfig */
    let ivConfig;
    /** @type VideoDecoder */
    let vDec;

    /** @type ?File */
    let currentFile;
    libav.onblockread = async function (filename, pos, length) {
        if (!currentFile || filename !== currentFile.name) {
            await libav.ff_block_reader_dev_send(filename, pos, null, {errorCode: libav.EIO});
        } else {
            await libav.ff_block_reader_dev_send(filename, pos,
                new Uint8Array(await currentFile.slice(pos, pos+length).arrayBuffer()));
        }
    };

    let currentStep = 0;
    const ALL_STEPS = [
        'FILE',
        'CROP',
        'CODE_BLOCK',
        'ORIENTATION',
        'RING',
        'TRIM',
        'CODEC',
        'OUTPUT'
    ];

    for (let i = 0; i < ALL_STEPS.length; i++)
        ALL_STEPS[ALL_STEPS[i]] = i;

    let config;
    const allParams = {
        threshold: parseInt,
        sensitivity: parseInt,
        blockSize: parseInt,
        orientation: v => v.split(',').map(n => parseInt(n)),
        cropL: parseInt,
        cropT: parseInt,
        cropR: parseInt,
        cropB: parseInt,
        outputDim: parseInt,
        ringRadius: parseInt,
        ringStroke: parseInt,
        trimStart: v => parseFloat(v) * 1000000,
        trimEnd: v => parseFloat(v) * 1000000,
        outputBitrate: v => parseFloat(v) * 1000000,
        keyInterval: v => parseFloat(v) * 1000000
    }

    let seekLock = new Lock();
    /** @type {VideoFrame[]} */
    const videoFrames = [];
    /** @type number */
    let scale = 1, videoDurationUs, peakFramerate, totalFrames, prevRot;

    /** @type ImageBitmap */
    let previewFrame;

    /** @type string */
    let outputFile, outputUrl;
    /** @type {(ArrayBuffer | Blob)[]} */
    let outputChunks;
    const outputChunkSize = 33554432;
    libav.onwrite = async function (filename, pos, data) {
        if (filename !== outputFile) return;
        outputChunks ??= [];

        const startChunk = Math.floor(pos / outputChunkSize);
        while (startChunk >= outputChunks.length)
            outputChunks.push(new ArrayBuffer(0, {maxByteLength: outputChunkSize}));

        if (outputChunks[startChunk] instanceof Blob)
            outputChunks[startChunk] = await outputChunks[startChunk].arrayBuffer();

        const chunkPos = pos % outputChunkSize;
        const chunkLen = outputChunkSize - chunkPos;
        const writeLen = Math.min(chunkLen, data.length);
        if (outputChunks[startChunk].byteLength < chunkPos + writeLen) {
            if (!outputChunks[startChunk].resizable) {
                const newData = new ArrayBuffer(chunkPos + writeLen, {maxByteLength: outputChunkSize});
                new Uint8Array(newData).set(new Uint8Array(outputChunks[startChunk]));
                outputChunks[startChunk] = newData;
            } else {
                outputChunks[startChunk].resize(chunkPos + writeLen);
            }
        }

        new Uint8Array(outputChunks[startChunk], chunkPos).set(data.subarray(0, writeLen));
        if (startChunk > 0 && startChunk < outputChunks.length - 1)
            if (outputChunks[startChunk].length === outputChunkSize)
                outputChunks[startChunk] = new Blob([outputChunks[startChunk]]);

        if (data.length > writeLen)
            await libav.onwrite(filename, pos + writeLen, data.subarray(writeLen));
    }

    const delay = t => new Promise(r => setTimeout(r, t));

    const getParameters = function () {
        const p = {};
        for (const key in allParams) {
            p[key] = allParams[key](document.getElementById(key).value);
        }

        scale = null;
        return config = p;
    }

    /** @type {{onmessage: ?function({data:any}), postMessage: function(any, any[])}[]} */ let renderWorkers = [];
    /** @type {[Promise<[ImageBitmap, ImageBitmap, number, number]>, function][]} */
    let renderQueue = [];
    let renderIds = [];
    let renderBusy = [];

    for (let i = 0; i < 6; i++) {
        let noWorker = false;
        try {
            renderWorkers.push(new Worker('js/render-worker.js?v=1/2025-03-04/1741056551/82ed9e8'));
        } catch {
            if (i !== 0) break;
            noWorker = true;
            window.renderWorkerCompat = {
                onmessage: null,
                postMessage: msg => setTimeout(() => window.renderWorkerCompat.proxy.onmessage?.({data: msg})),
                proxy: {
                    onmessage: null,
                    postMessage: msg => setTimeout(() => window.renderWorkerCompat.onmessage?.({data: msg})),
                }
            };

            const renderScript = document.createElement('script');
            renderScript.src = 'js/render-worker.js?v=1/2025-03-04/1741056551/82ed9e8';
            document.head.appendChild(renderScript);
            renderWorkers.push(window.renderWorkerCompat.proxy);
        }

        renderBusy.push(false);
        renderWorkers.at(-1).onmessage = (function(i) {
            return function (ev) {
                const [renderId, success, renderFrame, thr, rot] = ev.data;
                const prevWorker = renderIds.indexOf(renderId) - 1;

                const queueCompletion = function (fn) {
                    switch (prevWorker) {
                        case -2: throw null;
                        case -1: fn(); break;
                        default: renderQueue[prevWorker][0].then(fn); break;
                    }
                }

                if (!success) {
                    queueCompletion(() => {
                        renderWorkers[i].postMessage([renderId, config, renderFrame, rot, prevRot], [renderFrame]);
                    });
                } else {
                    renderBusy[i] = false;
                    queueCompletion(() => {
                        prevRot = rot;
                        if(renderId !== renderIds.shift()) throw null;
                        const [, resolve] = renderQueue.shift();
                        ev.data.shift();
                        resolve(ev.data);
                    });
                }
            };
        })(i);

        if (noWorker) {
            alert(translation.workerDegradation);
            break;
        }
    }

    const processFrame = function(frame) {
        const frameWidth = (frame.displayWidth ?? frame.width) - config.cropL - config.cropR;
        const frameHeight = (frame.displayHeight ?? frame.height) - config.cropT - config.cropB;

        if (!scale) {
            let outputDim = Math.floor(Math.sqrt(frameWidth * frameWidth + frameHeight * frameHeight));
            let mbDim = Math.floor(outputDim / 16) * 16;
            document.getElementById('outputDim').max = Math.min(mbDim, 5968);
            document.getElementById('outputDim').value = config.outputDim = Math.min(config.outputDim, mbDim, 5968);

            scale = Math.min(config.outputDim / outputDim, 1);
        }

        return new Promise(resolve => {
            const resolveFn = function() {
                for (let i = 0; i < renderBusy.length; i++) {
                    if (!renderBusy[i]) {
                        const renderId = new Date().getTime() + Math.random().toString().substring(1);
                        const renderCb = [null, null];
                        renderCb[0] = new Promise(resolve => renderCb[1] = resolve);
                        renderIds.push(renderId);
                        renderQueue.push(renderCb);

                        renderWorkers[i].postMessage([renderId, config, frame, scale, null], [frame]);
                        renderBusy[i] = true;

                        resolve([renderCb[0].then(v => {
                            const [blockImage, renderFrame, , rot] = v;
                            // let graphCtx;
                            // const outputDim = config.outputDim;
                            // const tsX = outputDim / 2 / videoDurationUs;
                            // graphCtx = document.getElementById('thrGraph').getContext('2d');
                            // graphCtx.fillStyle = 'white';
                            // graphCtx.drawImage(blockImage, frame.timestamp * tsX, 0);
                            // graphCtx.fillRect(frame.timestamp * tsX, 127-thr, Math.max(1,frame.duration*tsX), 1);
                            // graphCtx = document.getElementById('rotGraph').getContext('2d');
                            // graphCtx.fillStyle = 'white';
                            // for (const v of pval) {
                            //     graphCtx.fillRect(frame.timestamp * tsX, 128-v/2, Math.max(1,frame.duration*tsX), 1);
                            // }
                            blockImage.close();
                            renderFrame['rotationNum'] = rot;
                            return renderFrame;
                        })]);
                        return;
                    }
                }

                throw null;
            }

            if (renderBusy.reduce((a, b) => a && b, true)) {
                renderQueue.at(-1)[0].then(resolveFn);
            } else {
                resolveFn();
            }
        });
    }

    const updatePreview = async function () {
        config = getParameters();
        if (!previewFrame) return;

        const outputDim = config.outputDim;
        let previewCtx = previewCanvas.getContext('2d');
        previewCanvas.width = previewCanvas.height = config.outputDim / 2;
        // document.getElementById('thrGraph').width = document.getElementById('rotGraph').width = config.outputDim / 2;
        previewCtx.fillStyle = '#665577';
        previewCtx.fillRect(0, 0, outputDim, outputDim);

        if (currentStep <= ALL_STEPS.CODE_BLOCK) {
            let visibleSize = Math.ceil(config.blockSize / 2) * 4;
            const scaleFactor = Math.min(Math.floor((outputDim - 4) / 4 / visibleSize), 4);
            visibleSize = Math.max(visibleSize, Math.floor((outputDim - 4) / 16 / scaleFactor) * 4);
            const imageOption = {
                resizeQuality: "pixelated",
                resizeWidth: visibleSize * scaleFactor, resizeHeight: visibleSize * scaleFactor
            };

            const sourceLeft = Math.max(config.cropL - visibleSize / 4, 0);
            const sourceTop = Math.max(config.cropT - visibleSize / 4, 0);
            const sourceRight = previewFrame.width - Math.max(config.cropR - visibleSize / 4, 0) - visibleSize;
            const sourceBottom = previewFrame.height - Math.max(config.cropB - visibleSize / 4, 0) - visibleSize;
            const previewRight = previewCanvas.width - visibleSize * scaleFactor;

            const topLeft = createImageBitmap(previewFrame, sourceLeft, sourceTop, visibleSize, visibleSize, imageOption);
            const topRight = createImageBitmap(previewFrame, sourceRight, sourceTop, visibleSize, visibleSize, imageOption);
            const bottomLeft = createImageBitmap(previewFrame, sourceLeft, sourceBottom, visibleSize, visibleSize, imageOption);
            const bottomRight = createImageBitmap(previewFrame, sourceRight, sourceBottom, visibleSize, visibleSize, imageOption);

            previewCtx.drawImage(await topLeft, 0, 0);
            previewCtx.drawImage(await topRight, previewRight, 0);
            previewCtx.drawImage(await bottomLeft, 0, previewRight);
            previewCtx.drawImage(await bottomRight, previewRight, previewRight);

            previewCtx.fillStyle = 'red';
            previewCtx.fillRect((config.cropL - sourceLeft) * scaleFactor, 0, 1, previewCanvas.height);
            previewCtx.fillRect(0, (config.cropT - sourceTop) * scaleFactor, previewCanvas.width, 1);
            previewCtx.fillRect(previewCanvas.width - 1 - (config.cropR - Math.max(config.cropR - visibleSize / 4, 0)) * scaleFactor, 0, 1, previewCanvas.height);
            previewCtx.fillRect(0, previewCanvas.height - 1 - (config.cropB - Math.max(config.cropB - visibleSize / 4, 0)) * scaleFactor, previewCanvas.width, 1);
            previewCtx.fillStyle = 'green';
            previewCtx.fillRect((config.cropL - sourceLeft + config.blockSize) * scaleFactor, 0, 1, previewCanvas.height);
            previewCtx.fillRect(0, (config.cropT - sourceTop + config.blockSize) * scaleFactor, previewCanvas.width, 1);
            previewCtx.fillRect(previewCanvas.width - 1 - (config.cropR + config.blockSize - Math.max(config.cropR - visibleSize / 4, 0)) * scaleFactor, 0, 1, previewCanvas.height);
            previewCtx.fillRect(0, previewCanvas.height - 1 - (config.cropB + config.blockSize - Math.max(config.cropB - visibleSize / 4, 0)) * scaleFactor, previewCanvas.width, 1);
        } else {
            prevRot = 0;
            const processedFrame = await ((await processFrame(await createImageBitmap(previewFrame)))[0]);
            previewCtx.drawImage(processedFrame,
                0, 0, processedFrame.width, processedFrame.height,
                0, 0, previewCanvas.width, previewCanvas.height
            );
            previewCtx.drawImage(processedFrame, 0, 0, outputDim, outputDim,
                0, 0, outputDim / 2, outputDim / 2
            );
        }
    };

    const goToStep = function (n) {
        currentStep = n;
        document.getElementById('status').textContent = '';
        document.getElementById('seekControl').style.display = n ? 'block' : 'none';
        document.getElementById('stepControl').style.display = n ? 'block' : 'none';
        for (const div of document.querySelectorAll('div[data-step]'))
            div.style.display = (n === ALL_STEPS[div.dataset.step]) ? 'block' : 'none';

        switch(n) {
            case ALL_STEPS.OUTPUT:
                encodeVideo();
                document.getElementById('seekControl').style.display = 'none';
                document.getElementById('stepControl').style.display = 'none';
                try {
                    if (window.Notification && window.Notification?.permission !== 'granted') {
                        new Notification('');
                        Notification.requestPermission();
                    }
                } catch(e) {
                    if (!(e instanceof TypeError))
                        Notification.requestPermission();
                }
                return;
            case ALL_STEPS.RING:
                let frameWidth = previewFrame.width - config.cropL - config.cropR;
                let frameHeight = previewFrame.height - config.cropT - config.cropB;
                if (frameHeight > frameWidth) [frameHeight, frameWidth] = [frameWidth, frameHeight];
                const ringRadius = (frameWidth * 3 / frameHeight > 7) ? frameWidth / 7 * 3 : frameHeight;
                document.getElementById('ringRadius').max = frameWidth;
                document.getElementById('ringRadius').value = Math.floor(ringRadius * 1.5575 / 2);
                document.getElementById('ringStroke').value = Math.floor(3 * ringRadius / 328 - 46 / 41);
                break;
            case ALL_STEPS.TRIM:
                document.getElementById('trimEnd').value = Math.floor(videoDurationUs / 100000) / 10 - 2;
                break;
            case ALL_STEPS.CODEC:
                updateCodecs();
                break;
        }

        if (n)
            updatePreview();
    }

    const findCodecs = async function (w, h, fps) {
        w = Math.ceil(w/16)*16;
        h = Math.ceil(h/16)*16;
        const mbps = w*h*fps/256;

        const p = {
            avc1: {
                levels: [
                    // [10, 99, 1485],
                    // [11, 396, 3000],
                    // [12, 396, 6000],
                    // [13, 396, 11880],
                    // [20, 396, 11880],
                    // [21, 792, 19800],
                    // [22, 1620, 20250],
                    [30, 1620, 40500],
                    [31, 3600, 108000],
                    [32, 5120, 216000],
                    [40, 8192, 245760],
                    // [41, 8192, 245760],
                    [42, 8704, 522240],
                    [50, 22080, 589824],
                    [51, 36864, 983040],
                    [52, 36864, 2073600],
                    [60, 139264, 4177920],
                    [61, 139264, 8355840],
                    [62, 139264, 16711680],
                ],
                profiles: [
                    '640c', '4d0c', '4200'
                ],
                format: (level, profile) => `avc1.${profile}${level.toString(16).padStart(2, '0')}`,
                describe: str => {
                    let r = 'H.264/AVC L' + parseInt(str.slice(9,11), 16) / 10;

                    switch(str.slice(0, 7)) {
                        case 'avc1.4d': r += ' (Main)'; break;
                        case 'avc1.64': r += ' (HiP)'; break;
                        case 'avc1.42': r += ' (Base)'; break;
                    }

                    // switch(str.slice(9)) {
                    //     case '14': case '29': r += ' (High Bitrate)';
                    // }

                    return r;
                }
            },
            hvc1: {
                levels: [
                    // [30, 36864/256, 552960/256],
                    // [60, 122880/256, 3686400/256],
                    // [63, 245760/256, 7372800/256],
                    [90, 552960/256, 16588800/256],
                    [93, 983040/256, 33177600/256],
                    [120, 2228224/256, 66846720/256],
                    [123, 2228224/256, 133693440/256],
                    [150, 8912896/256, 267386880/256],
                    [153, 8912896/256, 534773760/256],
                    [156, 8912896/256, 1069547520/256],
                    [180, 35651584/256, 1069547520/256],
                    [183, 35651584/256, 2139095040/256],
                    [186, 35651584/256, 4278190080/256],
                ],
                tiers: [
                    'L', // 'H'
                ],
                format: (level, tier) => `hvc1.1.6.${tier}${level}.B0`,
                describe: str => {
                    let r = 'H.265/HEVC L' + parseInt(str.slice(10,13)) / 30;
                    if(str[9] === 'H')
                        r += ' (High Bitrate)';

                    return r;
                }
            },
            vp09: {
                levels: [
                    // [10, 36864/256, 829440/256],
                    // [11, 73728/256, 2764800/256],
                    // [20, 122880/256, 4608000/256],
                    // [21, 245760/256, 9216000/256],
                    [30, 552960/256, 20736000/256],
                    [31, 983040/256, 36864000/256],
                    [40, 2228224/256, 83558400/256],
                    [41, 2228224/256, 160432128/256],
                    [50, 8912896/256, 311951360/256],
                    [51, 8912896/256, 588251136/256],
                    [52, 8912896/256, 1176502272/256],
                    [60, 35651584/256, 1176502272/256],
                    [61, 35651584/256, 2353004544/256],
                    [62, 35651584/256, 4706009088/256],
                ],
                profiles: [
                    '01', '00', '12', '13'
                ],
                format: (level, profile) => `vp09.0${profile[0]}.${level}.08.0${profile[1]}.01.13.00.00`,
                describe: str => {
                    let r = 'VP9 L' + parseInt(str.slice(8,10)) / 10;
                    switch(str[15]) {
                        case '1': break;
                        case '0': r += ' (420J)'; break;
                        case '2': r += ' (422)'; break;
                        case '3': r += ' (444)'; break;
                    }

                    return r;
                }
            },
            vp8: {
                levels: [
                    [0, 35651584/256, 4706009088/256],
                ],
                format: () => `vp8`,
                describe: () => 'VP8'
            },
            av01: {
                levels: [
                    // [0, 147456/256, 4423680/256],
                    // [1, 278784/256, 8363520/256],
                    [4, 665856/256, 19975680/256],
                    [5, 1065024/256, 31950720/256],
                    [8, 2359296/256, 70778880/256],
                    [9, 2359296/256, 141557760/256],
                    [12, 8912896/256, 267386880/256],
                    [13, 8912896/256, 534773760/256],
                    [14, 8912896/256, 1069547520/256],
                    // [15, 8912896/256, 1069547520/256],
                    [16, 35651584/256, 1069547520/256],
                    [17, 35651584/256, 2139095040/256],
                    [18, 35651584/256, 4278190080/256],
                    // [19, 35651584/256, 4278190080/256],
                ],
                profiles: [
                    '0110','0111','0112','1000','2100'
                ],
                tiers: [
                    'M', // 'H'
                ],
                format: (level, profile, tier) => `av01.${profile[0]}.${level}${tier}.08.0.${profile.slice(1)}.01.13.00.0`,
                describe: str => {
                    let r = 'AV1 L';
                    let level = parseInt(str.split('.')[2]);
                    r += Math.floor(level / 4) + 2;
                    r += '.';
                    r += level & 3;

                    switch(str.split('.')[5]) {
                        case '110': break;
                        case '111': r += ' (420M)'; break;
                        case '112': r += ' (420J)'; break;
                        case '000': r += ' (444)'; break;
                        case '100': r += ' (422)'; break;
                    }

                    if(str.split('.')[2].endsWith('H'))
                        r += ' (High Bitrate)';

                    return r;
                }
            }
        };

        const supportedConfigs = [];
        for (const codec in p) {
            let supMbFrame = null, supMbSpeed = null;
            const supportedLevels = [];
            for (const [level, mbFrame, mbSpeed] of p[codec].levels) {
                if (w*h/256 > mbFrame) continue;
                if (mbps > mbSpeed) continue;
                if (mbSpeed !== (supMbSpeed ??= mbSpeed)) break;
                if (mbFrame !== (supMbFrame ??= mbFrame)) break;
                supportedLevels.push(level);
            }

            let configs = [[]];
            if (p[codec].tiers && p[codec].profiles) {
                configs.pop();
                for (const tier of p[codec].tiers) {
                    for (const profile of p[codec].profiles) {
                        configs.push([profile, tier]);
                    }
                }
            } else if (p[codec].tiers) {
                configs = p[codec].tiers.map(v => [v]);
            } else if (p[codec].profiles) {
                configs = p[codec].profiles.map(v => [v]);
            }

            for (const level of supportedLevels) {
                for (const config of configs) {
                    const codecStr = p[codec].format(level, ...config);
                    if((await VideoEncoder.isConfigSupported({codec: codecStr, width: w, height: h, framerate: 30, bitrateMode: 'variable'})).supported) {
                        supportedConfigs.push(codecStr);
                    }
                }
            }
        }

        return supportedConfigs.map(cfg => {
            const codec = cfg.split('.')[0];
            return {codec: cfg, desc: p[codec].describe(cfg)};
        });
    };

    const updateCodecs = async function () {
        const codecs = await findCodecs(config.outputDim, config.outputDim, peakFramerate ? peakFramerate : 120);
        const selectElement = document.getElementById('outputCodec');
        for (const child of [...selectElement.childNodes])
            child.remove();

        for (const codec of codecs) {
            const option = document.createElement('option');
            option.value = codec.codec;
            option.text = codec.desc;
            option.selected = selectElement.childElementCount === 0;
            selectElement.append(option);
        }
    };

    const estimateCrop = async function (cw, ch) {
        let voteL = Array.from({length: Math.floor(cw / 100)+2}, () => 0);
        let voteR = [...voteL];
        let voteT = Array.from({length: Math.floor(ch / 100)+2}, () => 0);
        let voteB = [...voteT];
        let frames = 0;
        const frameBuffer = new OffscreenCanvas(cw, ch);
        const fbContext = frameBuffer.getContext('2d', {willReadFrequently: true});

        const voteCrop = function(votes, coordinate) {
            let crop = votes.length-1;
            while (crop > 0) {
                const fbData = fbContext.getImageData(...coordinate(crop)).data;
                let canCrop = true;
                for (const b of fbData) {
                    if (b > 31 && b < 224) {
                        canCrop = false;
                        break;
                    }
                }

                if (canCrop) break;
                crop--;
            }
            votes[crop]++;
        };

        await libav.avformat_seek_file_approx(inCtx, -1, 0, 0, 0);
        while ((await libav.av_read_frame(inCtx, avpPkt)) === 0) {
            const avPkt = libav.ff_copyout_packet_sync(avpPkt);
            if (avPkt.stream_index !== ivStream.index) continue;
            vDec.decode(LibAVWebCodecsBridge.packetToEncodedVideoChunk(avPkt, ivStream));
            libav.av_packet_unref_sync(avpPkt);

            while (videoFrames.length) {
                const frame = videoFrames.shift();
                document.getElementById('status').textContent = `Analyzing ${(frame.timestamp/1000000).toFixed(2)}/${(videoDurationUs/1000000).toFixed(2)}`;

                frames++;
                fbContext.drawImage(frame, 0, 0);

                voteCrop(voteL, crop => [crop - 1, 0, 1, frame.displayWidth]);
                voteCrop(voteR, crop => [frame.displayWidth - crop, 0, 1, frame.displayHeight]);
                voteCrop(voteT, crop => [0, crop - 1, frame.displayWidth, 1]);
                voteCrop(voteB, crop => [0, frame.displayHeight - crop, frame.displayWidth, 1]);
                frame.close();

                switch (frames) {
                    case 33: {
                        await vDec.flush();
                        const [tslo, tshi] = libav.f64toi64(videoDurationUs * 0.45);
                        await libav.avformat_seek_file_approx(inCtx, -1, tslo, tshi, 0);
                        break;
                    }
                    case 66: {
                        await vDec.flush();
                        const [tslo, tshi] = libav.f64toi64(videoDurationUs * 0.9);
                        await libav.avformat_seek_file_approx(inCtx, -1, tslo, tshi, 0);
                        break;
                    }
                    case 99: {
                        await vDec.flush();
                        break;
                    }
                }
            }

            if (frames >= 99)
                break;
        }

        const vote = function(votes) {
            votes = [...votes];
            votes.pop();
            const thr = votes.reduce((a,b)=>a+b) * 4 / 5;
            return votes.reduce((a, b, i) => a[0] >= thr ? a : [a[0] + b, i], [0,0])[1];
        };

        document.getElementById('cropL').value = vote(voteL);
        document.getElementById('cropR').value = vote(voteR);
        document.getElementById('cropT').value = vote(voteT);
        document.getElementById('cropB').value = vote(voteB);
    };

    const estimateBlockSize = async function(lim) {
        let blockSize = 6, r = 0, g = 0, b = 0;
        config = getParameters();
        const frameBuffer = new OffscreenCanvas(lim+5, lim+5);
        const fbCtx = frameBuffer.getContext('2d', {willReadFrequently: true});

        const seekLoHi = libav.f64toi64(videoDurationUs / 8);
        await libav.avformat_seek_file_max(inCtx, -1, seekLoHi[0], seekLoHi[1], 0);
        while ((await libav.av_read_frame(inCtx, avpPkt)) === 0) {
            const avPkt = libav.ff_copyout_packet_sync(avpPkt);
            if (avPkt.stream_index !== ivStream.index) continue;
            let evc = LibAVWebCodecsBridge.packetToEncodedVideoChunk(avPkt, ivStream);
            vDec.decode(evc);
            libav.av_packet_unref_sync(avpPkt);
            if (vDec.decodeQueueSize > 2)
                await delay(evc.duration * vDec.decodeQueueSize / 2000);

            while (videoFrames.length) {
                const frame = videoFrames.shift();
                document.getElementById('status').textContent = `Analyzing ${(frame.timestamp/1000000).toFixed(2)}/${(videoDurationUs/1000000).toFixed(2)}`;

                fbCtx.drawImage(frame, config.cropL, config.cropT, frameBuffer.width, frameBuffer.height, 0, 0, frameBuffer.width, frameBuffer.height);
                const data = fbCtx.getImageData(2, 2, 3, 3);
                r = Array.from({length: data.height * data.width}, (_, i) => data.data[i * 4]).reduce((a, b) => a + b) / data.height / data.width;
                g = Array.from({length: data.height * data.width}, (_, i) => data.data[i * 4 + 1]).reduce((a, b) => a + b) / data.height / data.width;
                b = Array.from({length: data.height * data.width}, (_, i) => data.data[i * 4 + 2]).reduce((a, b) => a + b) / data.height / data.width;

                frame.close();
                if (r > 127 && g > 127) {
                    await vDec.flush();
                    break;
                }
            }

            if (r > 127 && g > 127) break;
        }

        if (r < 128 && g < 128) return;
        for(; blockSize <= lim; blockSize++) {
            const data = fbCtx.getImageData(1, 1, blockSize - 1, blockSize - 1);
            r = Array.from({length: data.height * data.width}, (_, i) => data.data[i*4]).reduce((a,b) => a+b) / data.height / data.width;
            g = Array.from({length: data.height * data.width}, (_, i) => data.data[i*4+1]).reduce((a,b) => a+b) / data.height / data.width;
            b = Array.from({length: data.height * data.width}, (_, i) => data.data[i*4+2]).reduce((a,b) => a+b) / data.height / data.width;
            const nextDat = [...fbCtx.getImageData(blockSize, 0, 1, blockSize).data, ...fbCtx.getImageData(0, blockSize, blockSize, 1).data];
            const nr = Array.from({length: blockSize*2}, (_, i) => nextDat[i*4]).reduce((a,b) => a+b) / blockSize / 2;
            const ng = Array.from({length: blockSize*2}, (_, i) => nextDat[i*4+1]).reduce((a,b) => a+b) / blockSize / 2;
            const nb = Array.from({length: blockSize*2}, (_, i) => nextDat[i*4+2]).reduce((a,b) => a+b) / blockSize / 2;

            if (Math.abs(nr-r) > 31 || Math.abs(ng-g) > 31 || Math.abs(nb-b) > 31) break;
        }

        document.getElementById('blockSize').value = blockSize;
    }

    const guessOrientation = async function () {
        config = getParameters();
        const seekLoHi = libav.f64toi64(videoDurationUs / 3);
        let rotationNum = [];
        await libav.avformat_seek_file_max(inCtx, -1, seekLoHi[0], seekLoHi[1], 0);
        while ((await libav.av_read_frame(inCtx, avpPkt)) === 0) {
            const avPkt = libav.ff_copyout_packet_sync(avpPkt);
            if (avPkt.stream_index !== ivStream.index) continue;
            let evc = LibAVWebCodecsBridge.packetToEncodedVideoChunk(avPkt, ivStream);
            vDec.decode(evc);
            libav.av_packet_unref_sync(avpPkt);
            if (vDec.decodeQueueSize > 2)
                await delay(evc.duration * vDec.decodeQueueSize / 2000);

            const processTasks = [];
            while (videoFrames.length) {
                const frame = videoFrames.shift();
                document.getElementById('status').textContent = `Analyzing ${(frame.timestamp/1000000).toFixed(2)}/${(videoDurationUs/1000000).toFixed(2)}`;
                processTasks.push((await processFrame(frame))[0].then(frame => {
                    if (rotationNum.length || frame.rotationNum)
                        rotationNum.push(frame.rotationNum);

                    frame.close();
                }));
            }

            await Promise.all(processTasks);
            if (rotationNum.length > 127)
                break;
        }

        const votes = [0,0,0,0];
        rotationNum = rotationNum.map(x => [
            Math.floor(x / 512) % 8,
            Math.floor(x / 64) % 8,
            Math.floor(x / 8) % 8,
            Math.floor(x / 1) % 8,
        ]);

        for(let d = 0; d < 3; d++) {
            const vote = Array.from({length: 4}, (_, i) => {
                const series = rotationNum.map(x => x[i]);
                let e = Array.from({length: 8}).map(() => 0);
                series.forEach(x => e[x]++);
                e = e.map(x => x ? Math.log2(series.length / x) : 0);
                return series.reduce((a, b) => a + e[b], 0) / series.length;
            });

            vote.forEach((v, i) => votes[i] += v * (d ? 2 : 1));

            rotationNum = rotationNum.map((x, i, a) => {
                if (!i) return [0,0,0,0];
                return x.map((v, n) => v-a[i-1][n]).map(v => v < 0 ? v + 8: v)
            });
            rotationNum.shift();
        }

        const votedOption = votes.indexOf(Math.max(...votes));
        const options = document.getElementById('orientation').querySelectorAll('option');
        options.forEach((e, i) => e.selected = i === votedOption);
    }

    document.getElementById('inputFile').onchange = async function () {
        document.getElementById('status').textContent = 'Loading';

        if (inCtx) {
            libav.avformat_close_input_js_sync(inCtx);
            inCtx = null;
        }

        if (vDec) {
            vDec.close();
            vDec = null;
        }

        if (currentFile)
            libav.unlink_sync(currentFile.name);

        currentFile = document.getElementById('inputFile').files[0];
        libav.mkblockreaderdev_sync(currentFile.name, currentFile.size);
        let inStreams;
        [inCtx, inStreams] = await libav.ff_init_demuxer_file(currentFile.name);
        ivStream = inStreams.filter(x => x.codec_type === LibAV.AVMEDIA_TYPE_VIDEO)[0];
        iaStream = inStreams.filter(x => x.codec_type === LibAV.AVMEDIA_TYPE_AUDIO)[0];
        totalFrames = Number(new BigUint64Array((libav.copyout_u8_sync(ivStream.ptr+48, 8)).buffer)[0]);
        videoDurationUs = ivStream.duration_time_base * ivStream.time_base_num * 1000000 / ivStream.time_base_den;

        document.getElementById('trimStart').max = document.getElementById('trimEnd').max = document.getElementById('seekPosition').max = Math.floor(videoDurationUs / 100000) / 10;
        document.getElementById('seekPosition').value = Math.floor(videoDurationUs / 2000000);

        ivConfig = await LibAVWebCodecsBridge.videoStreamToConfig(libav, ivStream);
        vDec = new VideoDecoder({
            error: e => console.log(e),
            output: async f => {
                if (f.duration)
                    peakFramerate = Math.max(peakFramerate, 1000000 / f.duration);

                if (videoFrames.length > 2) {
                    const frame = await createImageBitmap(f);
                    frame['displayHeight'] = f.displayHeight;
                    frame['displayWidth'] = f.displayWidth;
                    frame['duration'] = f.duration;
                    frame['timestamp'] = f.timestamp;
                    videoFrames.push(frame);
                    f.close();
                } else {
                    videoFrames.push(f);
                }
            },
        });
        vDec.configure(await LibAVWebCodecsBridge.videoStreamToConfig(libav, ivStream));
        document.getElementById('seekPosition').dispatchEvent(new Event("change"));

        goToStep(1);
    };

    document.getElementById('seekPosition').addEventListener('change', async function () {
        while (videoFrames.length)
            videoFrames.pop().close();

        const seekPos = parseFloat(this.value) * 1000000;
        const seekLoHi = libav.f64toi64(seekPos);
        this.previousValue ??= 0;

        await seekLock.acquire();
        try {
            let ec;
            if (this.value > this.previousValue && (videoDurationUs - seekPos) > 2000000) {
                ec = await libav.avformat_seek_file_min(inCtx, -1, seekLoHi[0], seekLoHi[1], 0);
            } else if (this.value < this.previousValue) {
                ec = await libav.avformat_seek_file_max(inCtx, -1, seekLoHi[0], seekLoHi[1], 0);
            } else {
                ec = await libav.avformat_seek_file_approx(inCtx, -1, seekLoHi[0], seekLoHi[1], 0);
            }

            if (ec)
                await libav.avformat_seek_file_max(inCtx, -1, seekLoHi[0], seekLoHi[1], 0);

            do {
                while ((await libav.av_read_frame(inCtx, avpPkt)) === 0) {
                    const avPkt = libav.ff_copyout_packet_sync(avpPkt);
                    if (avPkt.stream_index !== ivStream.index) continue;
                    let evc = LibAVWebCodecsBridge.packetToEncodedVideoChunk(avPkt, ivStream);
                    vDec.decode(evc);
                    libav.av_packet_unref_sync(avpPkt);
                    if (vDec.decodeQueueSize > 2)
                        await delay(evc.duration * vDec.decodeQueueSize / 2000);

                    if (videoFrames.length) {
                        break;
                    }
                }

                seekLoHi[0]--;
                await libav.avformat_seek_file_max(inCtx, -1, seekLoHi[0], seekLoHi[1], 0);
            } while(!videoFrames.length);

            await vDec.flush();
        } finally {
            seekLock.release();
        }

        await delay(0);
        if (videoFrames.length) {
            let closestFrame = videoFrames[0];
            let closestDelta = Math.abs(closestFrame.timestamp / 1000000 - this.value);
            for (const frame of videoFrames) {
                const delta = Math.abs(frame.timestamp / 1000000 - this.value);
                if (delta < closestDelta) {
                    closestFrame = frame;
                    closestDelta = delta;
                }
            }

            previewFrame = await createImageBitmap(closestFrame);
            this.value = Math.round(closestFrame.timestamp / 100000) / 10;
            document.getElementById('seekTimestamp').textContent = this.value;
            this.previousValue = this.value;

            while (videoFrames.length)
                videoFrames.pop().close();
        }

        await updatePreview();
    });

    document.getElementById('analyzeBtn').onclick = async function () {
        peakFramerate = 0;
        config = getParameters();

        document.getElementById('status').textContent = 'Analyzing';
        await estimateCrop(ivConfig.codedWidth, ivConfig.codedHeight);
        await estimateBlockSize(Math.floor(Math.max(ivConfig.codedWidth, ivConfig.codedHeight) / 100));
        await guessOrientation();
        while (videoFrames.length)
            videoFrames.pop().close();

        await updatePreview();
        document.getElementById('status').textContent = '';
    };

    const encodeVideo = async function () {
        config = getParameters()
        /** @type {[EncodedVideoChunk, EncodedVideoChunkMetadata][]} */
        const encodedChunks = [];
        const outputConfig = {
            codec: document.getElementById('outputCodec').value,
            bitrateMode: 'variable', contentHint: 'motion', framerate: 30,
            bitrate: config.outputBitrate * 30 / (totalFrames * 1000000 / videoDurationUs),
            width: config.outputDim, height: config.outputDim
        };

        document.getElementById('status').textContent = 'Loading';
        if (!(await VideoEncoder.isConfigSupported(outputConfig)).supported) {
            return;
        }

        let messages = 0, realTrimUs = -1;
        let seekStart = Math.max(config.trimStart - 100000, 0);
        let seekLoHi = libav.f64toi64(seekStart);

        if (iaStream) {
            await libav.avformat_seek_file_max(inCtx, -1, seekLoHi[0], seekLoHi[1], 0);
            while ((await libav.av_read_frame(inCtx, avpPkt)) === 0) {
                const avPkt = libav.ff_copyout_packet_sync(avpPkt);
                if (avPkt.stream_index === iaStream.index) {
                    const framePtsUs = avPkt.pts * iaStream.time_base_num * 1000000 / iaStream.time_base_den;
                    const frameEndUs = (avPkt.pts + avPkt.duration) * iaStream.time_base_num * 1000000 / iaStream.time_base_den;
                    realTrimUs = framePtsUs;
                    if (frameEndUs > config.trimStart) {
                        break;
                    }
                }
            }
        }

        const vEnc = new VideoEncoder({
            error: e => console.log(e),
            output: (chunk, metadata) => encodedChunks.push([chunk, metadata])
        });
        vEnc.configure(outputConfig);

        if (outputUrl) URL.revokeObjectURL(outputUrl);
        if (outputFile) libav.unlink_sync(outputFile);
        outputUrl = null;
        outputChunks = [];
        outputFile = new Date().getTime().toString() + '.';
        switch (outputConfig.codec.split('.')[0]) {
            case 'av01':
            case 'vp09':
            case 'vp8':
                // 0x15005 - AV_CODEC_ID_VORBIS
                // 0x1503c - AV_CODEC_ID_OPUS
                if (!iaStream || iaStream.codec_id === 0x1503c || iaStream.codec_id === 0x15005)
                    outputFile += 'webm';

            /* fallthrough */
            case 'avc1':
            case 'hvc1':
                if (!iaStream)
                    outputFile += 'mp4';
                else switch (iaStream.codec_id) {
                    case 0x15000+442-440: // AV_CODEC_ID_AAC
                    case 0x15000+443-440: // AV_CODEC_ID_AC3
                    case 0x15000+543-440: // AV_CODEC_ID_AC4
                    case 0x15000+456-440: // AV_CODEC_ID_ALAC
                    case 0x15000+444-440: // AV_CODEC_ID_DTS
                    case 0x15000+480-440: // AV_CODEC_ID_EAC3
                    case 0x15000+446-440: // AV_CODEC_ID_DVAUDIO
                    case 0x15000+458-440: // AV_CODEC_ID_GSM
                    case 0x15000+499-440: // AV_CODEC_ID_ILBC
                    case 0x15000+449-440: // AV_CODEC_ID_MACE3
                    case 0x15000+450-440: // AV_CODEC_ID_MACE6
                    case 0x15000+482-440: // AV_CODEC_ID_MP1
                    case 0x15000+440-440: // AV_CODEC_ID_MP2
                    case 0x15000+441-440: // AV_CODEC_ID_MP3
                    case 0x15000+473-440: // AV_CODEC_ID_NELLYMOSER
                    case 0x15000+464-440: // AV_CODEC_ID_QCELP
                    case 0x15000+459-440: // AV_CODEC_ID_QDM2
                    case 0x15000+490-440: // AV_CODEC_ID_QDMC
                    case 0x15000+475-440: // AV_CODEC_ID_SPEEX
                    case 0x15000+511-440: // AV_CODEC_ID_EVRC
                    case 0x15000+512-440: // AV_CODEC_ID_SMV
                    case 0x15000+452-440: // AV_CODEC_ID_FLAC
                    case 0x15000+484-440: // AV_CODEC_ID_TRUEHD
                    case 0x15000+500-440: // AV_CODEC_ID_OPUS
                    case 0x15000+531-440: // AV_CODEC_ID_MPEGH_3D_AUDIO
                    case 0x12000: // AV_CODEC_ID_AMR_NB
                    case 0x12001: // AV_CODEC_ID_AMR_WB
                    case 0x11000: // AV_CODEC_ID_ADPCM_IMA_QT
                    case 0x10000+334-328: // AV_CODEC_ID_PCM_MULAW
                    case 0x10000+335-328: // AV_CODEC_ID_PCM_ALAW
                    case 0x10000+348-328: // AV_CODEC_ID_PCM_F32BE
                    case 0x10000+349-328: // AV_CODEC_ID_PCM_F32LE
                    case 0x10000+350-328: // AV_CODEC_ID_PCM_F64BE
                    case 0x10000+351-328: // AV_CODEC_ID_PCM_F64LE
                    case 0x10000+329-328: // AV_CODEC_ID_PCM_S16BE
                    case 0x10000+328-328: // AV_CODEC_ID_PCM_S16LE
                    case 0x10000+341-328: // AV_CODEC_ID_PCM_S24BE
                    case 0x10000+340-328: // AV_CODEC_ID_PCM_S24LE
                    case 0x10000+337-328: // AV_CODEC_ID_PCM_S32BE
                    case 0x10000+336-328: // AV_CODEC_ID_PCM_S32LE
                    case 0x10000+332-328: // AV_CODEC_ID_PCM_S8
                    case 0x10000+333-328: // AV_CODEC_ID_PCM_U8
                        outputFile += 'mp4';
                        break;
                }

                break;
        }

        if (outputFile.endsWith('.'))
            outputFile += 'mkv';

        /** @type number */ let outCtx;
        /** @type {number|Packet[]} */ let outAvIo = [];
        /** @type {[number, number, number][]} */ let oStreams;
        libav.mkwriterdev_sync(outputFile);

        oStreams = [await LibAVWebCodecsBridge.configToVideoStream(libav, outputConfig)];
        oStreams[0][1] = ivStream.time_base_num; oStreams[0][2] = ivStream.time_base_den;
        if (iaStream)
            oStreams.push([iaStream.codecpar, iaStream.time_base_num, iaStream.time_base_den]);
        libav.AVCodecParameters_color_range_s_sync(oStreams[0][0], 2); // AVCOL_RANGE_JPEG

        const startTime = new Date().getTime();
        let lastKeyFrame = -1;

        const drainFrameQueue = async function () {
            let frames = [];
            while (videoFrames.length) {
                let frame = videoFrames.shift();
                if (frame.timestamp >= config.trimStart && realTrimUs < 0)
                    realTrimUs = frame.timestamp;

                document.getElementById('status').textContent = `${((frame.timestamp+frame.duration)/1000000).toFixed(2)} / ${(videoDurationUs/1000000).toFixed(2)}`;
                if (frame.timestamp < realTrimUs || frame.timestamp >= config.trimEnd) {
                    frame.close();
                    continue;
                }

                let keyFrame = false;
                if (lastKeyFrame < 0) lastKeyFrame = frame.timestamp;
                if (config.keyInterval >= 0 && ((frame.timestamp + frame.duration) > (lastKeyFrame + config.keyInterval))) {
                    keyFrame = true;
                    lastKeyFrame = frame.timestamp;
                }

                frames.push((await processFrame(frame))[0].then(renderFrame => {
                    const vFrame = new VideoFrame(renderFrame, {timestamp: frame.timestamp - realTrimUs, duration: frame.duration});
                    vEnc.encode(vFrame, {keyFrame: keyFrame});
                    vFrame.close();

                    const previewCtx = previewCanvas.getContext('2d');
                    previewCtx.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
                    previewCtx.drawImage(renderFrame,
                        0, 0, renderFrame.width, renderFrame.height,
                        0, 0, previewCanvas.width, previewCanvas.height
                    );
                }));
            }

            return frames;
        };

        const drainEvcQueue = async function () {
            while (encodedChunks.length) {
                const [evc, metadata] = encodedChunks.shift();
                if (evc.type === "key")
                    lastKeyFrame = Math.max(lastKeyFrame, evc.timestamp);

                const avPkt = await LibAVWebCodecsBridge.encodedVideoChunkToPacket(libav, evc, metadata, oStreams[0], 0);
                if (typeof outCtx !== "number") {
                    const bufferedPackets = outAvIo;
                    bufferedPackets.push(avPkt);

                    [outCtx, , outAvIo,] = libav.ff_init_muxer_sync({
                        filename: outputFile, open: true, codecpars: true
                    }, oStreams);
                    libav.avformat_write_header_sync(outCtx, null);
                    libav.ff_write_multi_sync(outCtx, avpPkt, bufferedPackets, true);
                } else {
                    libav.ff_write_multi_sync(outCtx, avpPkt, [avPkt], true);
                }
            }
        }

        let wakeLock, audioEnd, videoEnd, lastFrame;
        try {
            if (navigator.wakeLock) {
                try {
                    wakeLock = await navigator.wakeLock.request("screen");
                } catch {}
            }
            await libav.avformat_seek_file_max(inCtx, -1, seekLoHi[0], seekLoHi[1], 0);
            while ((await libav.av_read_frame(inCtx, avpPkt)) === 0) {
                const avPkt = libav.ff_copyout_packet_sync(avpPkt);
                if (avPkt.stream_index === iaStream?.index) {
                    const framePtsUs = avPkt.pts * iaStream.time_base_num * 1000000 / iaStream.time_base_den;
                    if (framePtsUs > config.trimEnd)
                        audioEnd = true;

                    if (framePtsUs >= realTrimUs && !audioEnd) {
                        const tsAdj = realTrimUs * iaStream.time_base_den / iaStream.time_base_num / 1000000;
                        avPkt.pts -= tsAdj;
                        if (avPkt.pts < 0)
                            avPkt.ptshi -= 1;

                        avPkt.dts -= tsAdj;
                        if (avPkt.dts < 0)
                            avPkt.dtshi -= 1;

                        avPkt.stream_index = 1;
                        avPkt.time_base_num = iaStream.time_base_num;
                        avPkt.time_base_den = iaStream.time_base_den;
                        if (typeof outCtx === "number") {
                            libav.ff_write_multi_sync(outCtx, avpPktW, [avPkt], true);
                        } else {
                            outAvIo.push(avPkt);
                        }
                    }
                } else if (avPkt.stream_index === ivStream.index) {
                    const framePtsUs = avPkt.pts * ivStream.time_base_num * 1000000 / ivStream.time_base_den;
                    if (framePtsUs > config.trimEnd) {
                        videoEnd = true;
                    } else {
                        vDec.decode(LibAVWebCodecsBridge.packetToEncodedVideoChunk(avPkt, ivStream));
                        messages++;
                    }
                }

                libav.av_packet_unref_sync(avpPkt);
                lastFrame = (await drainFrameQueue()).at(-1) ?? lastFrame;
                await drainEvcQueue();

                const maxQ = Math.max(vDec.decodeQueueSize, vEnc.encodeQueueSize);
                if (maxQ > 16) {
                    let now = new Date().getTime();
                    let messagesPerMs = messages / (now - startTime);
                    await delay(maxQ / messagesPerMs / 4);
                }

                if (audioEnd && videoEnd)
                    break;
            }

            await vDec.flush();
            await ((await drainFrameQueue()).at(-1) ?? lastFrame);
            await vEnc.flush();
            await drainEvcQueue();
        } finally {
            if (typeof outCtx === "number" && typeof outAvIo === "number") {
                libav.av_write_trailer_sync(outCtx);
                libav.avio_close_sync(outAvIo);
                libav.avformat_free_context_sync(outCtx);
            }

            vEnc.close();
            await wakeLock?.release();
        }

        for (let i = 0; i < outputChunks.length; i++) {
            if (outputChunks[i] instanceof ArrayBuffer && outputChunks[i].resizable) {
                const data = outputChunks[i];
                outputChunks[i] = new ArrayBuffer((i === (outputChunks.length-1)) ? data.byteLength : outputChunkSize);
                new Uint8Array(outputChunks[i]).set(new Uint8Array(data));
            }
        }

        const outputBlob = new Blob(outputChunks, {
            type: outputFile.endsWith('.mkv') ? 'video/matroska' : (outputFile.endsWith('.mp4') ? 'video/mp4' : (outputFile.endsWith('.webm') ? 'video/webm' : 'application/octet-stream'))
        });
        outputChunks = [outputBlob];
        outputUrl = URL.createObjectURL(outputBlob);
        document.getElementById('download').href = outputUrl;
        document.getElementById('download').setAttribute('download', outputFile);
        document.getElementById('status').textContent = 'OK';
        document.getElementById('encodingMsg').style.display = 'none';

        if (window.Notification?.permission === "granted") {
            new Notification(translation.encodeDoneMessage);
        } else {
            alert(translation.encodeDoneMessage);
        }
    };

    for (const cfgOption of document.querySelectorAll('div.realtime-update input, div.realtime-update select')) {
        cfgOption.onchange = updatePreview;
    }

    document.getElementById('outputDim').onchange = async function() {
        document.getElementById('outputDim').value = Math.floor(document.getElementById('outputDim').value / 16) * 16;
        await updatePreview();
        await updateCodecs();
    };

    document.getElementById('btnNextStep').onclick = function() {
        goToStep(currentStep + 1);
    }

    goToStep(0);
};