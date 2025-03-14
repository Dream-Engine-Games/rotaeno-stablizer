/**
 * Encoder module for Rotaeno Stabilizer
 */

import { delay } from './utils.js';

/**
 * VideoEncoder class for handling video encoding operations
 */
export class VideoEncoder {
    /**
     * Initialize the video encoder
     * @param {Object} libav - LibAV instance
     * @param {Object} videoProcessor - Video processor instance
     * @param {Object} fileManager - File manager instance
     * @param {Object} renderer - Renderer instance
     */
    constructor(libav, videoProcessor, fileManager, renderer) {
        this.libav = libav;
        this.videoProcessor = videoProcessor;
        this.fileManager = fileManager;
        this.renderer = renderer;
    }

    /**
     * Encode the video with the given configuration
     * @param {Object} config - Encoding configuration
     * @returns {Promise<boolean>} - True if successful
     */
    async encodeVideo(config) {
        try {
            /** @type {[EncodedVideoChunk, EncodedVideoChunkMetadata][]} */
            const encodedChunks = [];
            const outputConfig = {
                codec: document.getElementById('outputCodec').value,
                bitrateMode: 'variable', contentHint: 'motion', framerate: 30,
                bitrate: config.outputBitrate * 30 / (this.videoProcessor.totalFrames * 1000000 / this.videoProcessor.videoDurationUs),
                width: config.outputDim, height: config.outputDim
            };

            document.getElementById('status').textContent = 'Loading';
            if (!(await window.VideoEncoder.isConfigSupported(outputConfig)).supported) {
                document.getElementById('status').textContent = 'Codec not supported';
                return false;
            }

            let messages = 0, realTrimUs = -1;
            let seekStart = Math.max(config.trimStart - 100000, 0);
            let seekLoHi = this.libav.f64toi64(seekStart);

            if (this.videoProcessor.iaStream) {
                await this.libav.avformat_seek_file_max(this.videoProcessor.inCtx, -1, seekLoHi[0], seekLoHi[1], 0);
                while ((await this.libav.av_read_frame(this.videoProcessor.inCtx, this.libav.avpPkt)) === 0) {
                    const avPkt = this.libav.ff_copyout_packet_sync(this.libav.avpPkt);
                    if (avPkt.stream_index === this.videoProcessor.iaStream.index) {
                        const framePtsUs = avPkt.pts * this.videoProcessor.iaStream.time_base_num * 1000000 / this.videoProcessor.iaStream.time_base_den;
                        const frameEndUs = (avPkt.pts + avPkt.duration) * this.videoProcessor.iaStream.time_base_num * 1000000 / this.videoProcessor.iaStream.time_base_den;
                        realTrimUs = framePtsUs;
                        if (frameEndUs > config.trimStart) {
                            break;
                        }
                    }
                }
            }

            const vEnc = new window.VideoEncoder({
                error: e => console.log(e),
                output: (chunk, metadata) => encodedChunks.push([chunk, metadata])
            });
            vEnc.configure(outputConfig);

            // Create output file
            const codecType = outputConfig.codec.split('.')[0];
            this.fileManager.createOutputFile(codecType, this.videoProcessor.iaStream);

            /** @type number */ let outCtx;
            /** @type {number|Packet[]} */ let outAvIo = [];
            /** @type {[number, number, number][]} */ let oStreams;
            
            oStreams = [await LibAVWebCodecsBridge.configToVideoStream(this.libav, outputConfig)];
            oStreams[0][1] = this.videoProcessor.ivStream.time_base_num; 
            oStreams[0][2] = this.videoProcessor.ivStream.time_base_den;
            
            if (this.videoProcessor.iaStream) {
                oStreams.push([
                    this.videoProcessor.iaStream.codecpar, 
                    this.videoProcessor.iaStream.time_base_num, 
                    this.videoProcessor.iaStream.time_base_den
                ]);
            }
            
            this.libav.AVCodecParameters_color_range_s_sync(oStreams[0][0], 2); // AVCOL_RANGE_JPEG

            const startTime = new Date().getTime();
            let lastKeyFrame = -1;

            const drainFrameQueue = async () => {
                let frames = [];
                while (this.videoProcessor.videoFrames.length) {
                    let frame = this.videoProcessor.videoFrames.shift();
                    if (frame.timestamp >= config.trimStart && realTrimUs < 0)
                        realTrimUs = frame.timestamp;

                    document.getElementById('status').textContent = `${((frame.timestamp+frame.duration)/1000000).toFixed(2)} / ${(this.videoProcessor.videoDurationUs/1000000).toFixed(2)}`;
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

                    frames.push((await this.renderer.processFrame(frame))[0].then(renderFrame => {
                        const vFrame = new VideoFrame(renderFrame, {timestamp: frame.timestamp - realTrimUs, duration: frame.duration});
                        vEnc.encode(vFrame, {keyFrame: keyFrame});
                        vFrame.close();

                        const previewCtx = document.getElementById('preview').getContext('2d');
                        previewCtx.clearRect(0, 0, document.getElementById('preview').width, document.getElementById('preview').height);
                        previewCtx.drawImage(renderFrame,
                            0, 0, renderFrame.width, renderFrame.height,
                            0, 0, document.getElementById('preview').width, document.getElementById('preview').height
                        );
                    }));
                }

                return frames;
            };

            const drainEvcQueue = async () => {
                while (encodedChunks.length) {
                    const [evc, metadata] = encodedChunks.shift();
                    if (evc.type === "key")
                        lastKeyFrame = Math.max(lastKeyFrame, evc.timestamp);

                    const avPkt = await LibAVWebCodecsBridge.encodedVideoChunkToPacket(this.libav, evc, metadata, oStreams[0], 0);
                    if (typeof outCtx !== "number") {
                        const bufferedPackets = outAvIo;
                        bufferedPackets.push(avPkt);

                        [outCtx, , outAvIo,] = this.libav.ff_init_muxer_sync({
                            filename: this.fileManager.outputFile, open: true, codecpars: true
                        }, oStreams);
                        this.libav.avformat_write_header_sync(outCtx, null);
                        this.libav.ff_write_multi_sync(outCtx, this.libav.avpPkt, bufferedPackets, true);
                    } else {
                        this.libav.ff_write_multi_sync(outCtx, this.libav.avpPkt, [avPkt], true);
                    }
                }
            };

            let wakeLock, audioEnd, videoEnd, lastFrame;
            try {
                if (navigator.wakeLock) {
                    try {
                        wakeLock = await navigator.wakeLock.request("screen");
                    } catch {}
                }
                await this.libav.avformat_seek_file_max(this.videoProcessor.inCtx, -1, seekLoHi[0], seekLoHi[1], 0);
                while ((await this.libav.av_read_frame(this.videoProcessor.inCtx, this.libav.avpPkt)) === 0) {
                    const avPkt = this.libav.ff_copyout_packet_sync(this.libav.avpPkt);
                    if (avPkt.stream_index === this.videoProcessor.iaStream?.index) {
                        const framePtsUs = avPkt.pts * this.videoProcessor.iaStream.time_base_num * 1000000 / this.videoProcessor.iaStream.time_base_den;
                        if (framePtsUs > config.trimEnd)
                            audioEnd = true;

                        if (framePtsUs >= realTrimUs && !audioEnd) {
                            const tsAdj = realTrimUs * this.videoProcessor.iaStream.time_base_den / this.videoProcessor.iaStream.time_base_num / 1000000;
                            avPkt.pts -= tsAdj;
                            if (avPkt.pts < 0)
                                avPkt.ptshi -= 1;

                            avPkt.dts -= tsAdj;
                            if (avPkt.dts < 0)
                                avPkt.dtshi -= 1;

                            avPkt.stream_index = 1;
                            avPkt.time_base_num = this.videoProcessor.iaStream.time_base_num;
                            avPkt.time_base_den = this.videoProcessor.iaStream.time_base_den;
                            if (typeof outCtx === "number") {
                                this.libav.ff_write_multi_sync(outCtx, this.libav.avpPktW, [avPkt], true);
                            } else {
                                outAvIo.push(avPkt);
                            }
                        }
                    } else if (avPkt.stream_index === this.videoProcessor.ivStream.index) {
                        const framePtsUs = avPkt.pts * this.videoProcessor.ivStream.time_base_num * 1000000 / this.videoProcessor.ivStream.time_base_den;
                        if (framePtsUs > config.trimEnd) {
                            videoEnd = true;
                        } else {
                            this.videoProcessor.vDec.decode(LibAVWebCodecsBridge.packetToEncodedVideoChunk(avPkt, this.videoProcessor.ivStream));
                            messages++;
                        }
                    }

                    this.libav.av_packet_unref_sync(this.libav.avpPkt);
                    lastFrame = (await drainFrameQueue()).at(-1) ?? lastFrame;
                    await drainEvcQueue();

                    const maxQ = Math.max(this.videoProcessor.vDec.decodeQueueSize, vEnc.encodeQueueSize);
                    if (maxQ > 16) {
                        let now = new Date().getTime();
                        let messagesPerMs = messages / (now - startTime);
                        await delay(maxQ / messagesPerMs / 4);
                    }

                    if (audioEnd && videoEnd)
                        break;
                }

                await this.videoProcessor.vDec.flush();
                await ((await drainFrameQueue()).at(-1) ?? lastFrame);
                await vEnc.flush();
                await drainEvcQueue();
            } finally {
                if (typeof outCtx === "number" && typeof outAvIo === "number") {
                    this.libav.av_write_trailer_sync(outCtx);
                    this.libav.avio_close_sync(outAvIo);
                    this.libav.avformat_free_context_sync(outCtx);
                }

                vEnc.close();
                await wakeLock?.release();
            }

            // Finalize output file
            this.fileManager.finalizeOutput();
            
            // Update UI
            document.getElementById('status').textContent = 'OK';
            document.getElementById('encodingMsg').style.display = 'none';

            // Show notification
            const translation = window.translation || { encodeDoneMessage: 'Encoding completed' };
            if (window.Notification?.permission === "granted") {
                new Notification(translation.encodeDoneMessage);
            } else {
                alert(translation.encodeDoneMessage);
            }
            
            return true;
        } catch (error) {
            console.error('Error encoding video:', error);
            document.getElementById('status').textContent = 'Error encoding video';
            return false;
        }
    }
} 