/**
 * Video Processor module for Rotaeno Stabilizer
 */

import { delay } from './utils.js';

/**
 * VideoProcessor class for handling video processing operations
 */
export class VideoProcessor {
    /**
     * Initialize the video processor
     * @param {Object} libav - LibAV instance
     * @param {Object} fileManager - File manager instance
     */
    constructor(libav, fileManager) {
        this.libav = libav;
        this.fileManager = fileManager;
        this.inCtx = null;
        this.ivStream = null;
        this.iaStream = null;
        this.ivConfig = null;
        this.vDec = null;
        this.videoFrames = [];
        this.peakFramerate = 0;
        this.videoDurationUs = 0;
        this.totalFrames = 0;
        this.previewFrame = null;
        this.prevRot = null;
    }

    /**
     * Initialize the video decoder for a file
     * @param {File} file - Input file
     * @returns {Promise<boolean>} - True if successful
     */
    async initializeDecoder(file) {
        try {
            if (this.inCtx) {
                this.libav.avformat_close_input_js_sync(this.inCtx);
                this.inCtx = null;
            }

            if (this.vDec) {
                this.vDec.close();
                this.vDec = null;
            }

            if (this.fileManager.currentFile) {
                this.libav.unlink_sync(this.fileManager.currentFile.name);
            }

            this.fileManager.setCurrentFile(file);
            this.libav.mkblockreaderdev_sync(file.name, file.size);
            
            let inStreams;
            [this.inCtx, inStreams] = await this.libav.ff_init_demuxer_file(file.name);
            this.ivStream = inStreams.filter(x => x.codec_type === LibAV.AVMEDIA_TYPE_VIDEO)[0];
            this.iaStream = inStreams.filter(x => x.codec_type === LibAV.AVMEDIA_TYPE_AUDIO)[0];
            this.totalFrames = Number(new BigUint64Array((this.libav.copyout_u8_sync(this.ivStream.ptr+48, 8)).buffer)[0]);
            this.videoDurationUs = this.ivStream.duration_time_base * this.ivStream.time_base_num * 1000000 / this.ivStream.time_base_den;

            // Update UI elements
            document.getElementById('trimStart').max = 
            document.getElementById('trimEnd').max = 
            document.getElementById('seekPosition').max = Math.floor(this.videoDurationUs / 100000) / 10;
            document.getElementById('seekPosition').value = Math.floor(this.videoDurationUs / 2000000);

            this.ivConfig = await LibAVWebCodecsBridge.videoStreamToConfig(this.libav, this.ivStream);
            this.vDec = new VideoDecoder({
                error: e => console.log(e),
                output: async f => {
                    if (f.duration)
                        this.peakFramerate = Math.max(this.peakFramerate, 1000000 / f.duration);

                    if (this.videoFrames.length > 2) {
                        const frame = await createImageBitmap(f);
                        frame['displayHeight'] = f.displayHeight;
                        frame['displayWidth'] = f.displayWidth;
                        frame['duration'] = f.duration;
                        frame['timestamp'] = f.timestamp;
                        this.videoFrames.push(frame);
                        f.close();
                    } else {
                        this.videoFrames.push(f);
                    }
                },
            });
            this.vDec.configure(await LibAVWebCodecsBridge.videoStreamToConfig(this.libav, this.ivStream));
            
            return true;
        } catch (error) {
            console.error('Error initializing decoder:', error);
            return false;
        }
    }

    /**
     * Seek to a specific position in the video
     * @param {number} seekPos - Position to seek to in microseconds
     * @param {Object} seekLock - Lock for synchronizing seek operations
     * @returns {Promise<boolean>} - True if successful
     */
    async seekToPosition(seekPos, seekLock) {
        try {
            while (this.videoFrames.length) {
                this.videoFrames.pop().close();
            }

            const seekLoHi = this.libav.f64toi64(seekPos);
            const previousValue = document.getElementById('seekPosition').previousValue ?? 0;

            await seekLock.acquire();
            try {
                let ec;
                if (seekPos > previousValue && (this.videoDurationUs - seekPos) > 2000000) {
                    ec = await this.libav.avformat_seek_file_min(this.inCtx, -1, seekLoHi[0], seekLoHi[1], 0);
                } else if (seekPos < previousValue) {
                    ec = await this.libav.avformat_seek_file_max(this.inCtx, -1, seekLoHi[0], seekLoHi[1], 0);
                } else {
                    ec = await this.libav.avformat_seek_file_approx(this.inCtx, -1, seekLoHi[0], seekLoHi[1], 0);
                }

                if (ec) {
                    await this.libav.avformat_seek_file_max(this.inCtx, -1, seekLoHi[0], seekLoHi[1], 0);
                }

                do {
                    while ((await this.libav.av_read_frame(this.inCtx, this.libav.avpPkt)) === 0) {
                        const avPkt = this.libav.ff_copyout_packet_sync(this.libav.avpPkt);
                        if (avPkt.stream_index !== this.ivStream.index) continue;
                        let evc = LibAVWebCodecsBridge.packetToEncodedVideoChunk(avPkt, this.ivStream);
                        this.vDec.decode(evc);
                        this.libav.av_packet_unref_sync(this.libav.avpPkt);
                        if (this.vDec.decodeQueueSize > 2)
                            await delay(evc.duration * this.vDec.decodeQueueSize / 2000);

                        if (this.videoFrames.length) {
                            break;
                        }
                    }

                    seekLoHi[0]--;
                    await this.libav.avformat_seek_file_max(this.inCtx, -1, seekLoHi[0], seekLoHi[1], 0);
                } while(!this.videoFrames.length);

                await this.vDec.flush();
            } finally {
                seekLock.release();
            }

            await delay(0);
            if (this.videoFrames.length) {
                let closestFrame = this.videoFrames[0];
                let closestDelta = Math.abs(closestFrame.timestamp / 1000000 - seekPos / 1000000);
                for (const frame of this.videoFrames) {
                    const delta = Math.abs(frame.timestamp / 1000000 - seekPos / 1000000);
                    if (delta < closestDelta) {
                        closestFrame = frame;
                        closestDelta = delta;
                    }
                }

                this.previewFrame = await createImageBitmap(closestFrame);
                document.getElementById('seekPosition').value = Math.round(closestFrame.timestamp / 100000) / 10;
                document.getElementById('seekTimestamp').textContent = document.getElementById('seekPosition').value;
                document.getElementById('seekPosition').previousValue = document.getElementById('seekPosition').value;

                while (this.videoFrames.length)
                    this.videoFrames.pop().close();
                
                return true;
            }
            
            return false;
        } catch (error) {
            console.error('Error seeking to position:', error);
            return false;
        }
    }

    /**
     * Estimate crop values by analyzing video frames
     * @param {number} cw - Width of the video
     * @param {number} ch - Height of the video
     * @returns {Promise<Object>} - Estimated crop values
     */
    async estimateCrop(cw, ch) {
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

        await this.libav.avformat_seek_file_approx(this.inCtx, -1, 0, 0, 0);
        while ((await this.libav.av_read_frame(this.inCtx, this.libav.avpPkt)) === 0) {
            const avPkt = this.libav.ff_copyout_packet_sync(this.libav.avpPkt);
            if (avPkt.stream_index !== this.ivStream.index) continue;
            this.vDec.decode(LibAVWebCodecsBridge.packetToEncodedVideoChunk(avPkt, this.ivStream));
            this.libav.av_packet_unref_sync(this.libav.avpPkt);

            while (this.videoFrames.length) {
                const frame = this.videoFrames.shift();
                document.getElementById('status').textContent = `Analyzing ${(frame.timestamp/1000000).toFixed(2)}/${(this.videoDurationUs/1000000).toFixed(2)}`;

                frames++;
                fbContext.drawImage(frame, 0, 0);

                voteCrop(voteL, crop => [crop - 1, 0, 1, frame.displayWidth]);
                voteCrop(voteR, crop => [frame.displayWidth - crop, 0, 1, frame.displayHeight]);
                voteCrop(voteT, crop => [0, crop - 1, frame.displayWidth, 1]);
                voteCrop(voteB, crop => [0, frame.displayHeight - crop, frame.displayWidth, 1]);
                frame.close();

                switch (frames) {
                    case 33: {
                        await this.vDec.flush();
                        const [tslo, tshi] = this.libav.f64toi64(this.videoDurationUs * 0.45);
                        await this.libav.avformat_seek_file_approx(this.inCtx, -1, tslo, tshi, 0);
                        break;
                    }
                    case 66: {
                        await this.vDec.flush();
                        const [tslo, tshi] = this.libav.f64toi64(this.videoDurationUs * 0.9);
                        await this.libav.avformat_seek_file_approx(this.inCtx, -1, tslo, tshi, 0);
                        break;
                    }
                    case 99: {
                        await this.vDec.flush();
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

        return {
            cropL: vote(voteL),
            cropR: vote(voteR),
            cropT: vote(voteT),
            cropB: vote(voteB)
        };
    }

    /**
     * Estimate block size by analyzing video frames
     * @param {number} lim - Maximum block size to consider
     * @param {Object} config - Current configuration
     * @returns {Promise<number>} - Estimated block size
     */
    async estimateBlockSize(lim, config) {
        let blockSize = 6, r = 0, g = 0, b = 0;
        const frameBuffer = new OffscreenCanvas(lim+5, lim+5);
        const fbCtx = frameBuffer.getContext('2d', {willReadFrequently: true});

        const seekLoHi = this.libav.f64toi64(this.videoDurationUs / 8);
        await this.libav.avformat_seek_file_max(this.inCtx, -1, seekLoHi[0], seekLoHi[1], 0);
        while ((await this.libav.av_read_frame(this.inCtx, this.libav.avpPkt)) === 0) {
            const avPkt = this.libav.ff_copyout_packet_sync(this.libav.avpPkt);
            if (avPkt.stream_index !== this.ivStream.index) continue;
            let evc = LibAVWebCodecsBridge.packetToEncodedVideoChunk(avPkt, this.ivStream);
            this.vDec.decode(evc);
            this.libav.av_packet_unref_sync(this.libav.avpPkt);
            if (this.vDec.decodeQueueSize > 2)
                await delay(evc.duration * this.vDec.decodeQueueSize / 2000);

            while (this.videoFrames.length) {
                const frame = this.videoFrames.shift();
                document.getElementById('status').textContent = `Analyzing ${(frame.timestamp/1000000).toFixed(2)}/${(this.videoDurationUs/1000000).toFixed(2)}`;

                fbCtx.drawImage(frame, config.cropL, config.cropT, frameBuffer.width, frameBuffer.height, 0, 0, frameBuffer.width, frameBuffer.height);
                const data = fbCtx.getImageData(2, 2, 3, 3);
                r = Array.from({length: data.height * data.width}, (_, i) => data.data[i * 4]).reduce((a, b) => a + b) / data.height / data.width;
                g = Array.from({length: data.height * data.width}, (_, i) => data.data[i * 4 + 1]).reduce((a, b) => a + b) / data.height / data.width;
                b = Array.from({length: data.height * data.width}, (_, i) => data.data[i * 4 + 2]).reduce((a, b) => a + b) / data.height / data.width;

                frame.close();
                if (r > 127 && g > 127) {
                    await this.vDec.flush();
                    break;
                }
            }

            if (r > 127 && g > 127) break;
        }

        if (r < 128 && g < 128) return blockSize;
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

        return blockSize;
    }

    /**
     * Guess the orientation by analyzing video frames
     * @param {Object} config - Current configuration
     * @param {Function} processFrame - Function to process a frame
     * @returns {Promise<number>} - Guessed orientation index
     */
    async guessOrientation(config, processFrame) {
        const seekLoHi = this.libav.f64toi64(this.videoDurationUs / 3);
        let rotationNum = [];
        await this.libav.avformat_seek_file_max(this.inCtx, -1, seekLoHi[0], seekLoHi[1], 0);
        while ((await this.libav.av_read_frame(this.inCtx, this.libav.avpPkt)) === 0) {
            const avPkt = this.libav.ff_copyout_packet_sync(this.libav.avpPkt);
            if (avPkt.stream_index !== this.ivStream.index) continue;
            let evc = LibAVWebCodecsBridge.packetToEncodedVideoChunk(avPkt, this.ivStream);
            this.vDec.decode(evc);
            this.libav.av_packet_unref_sync(this.libav.avpPkt);
            if (this.vDec.decodeQueueSize > 2)
                await delay(evc.duration * this.vDec.decodeQueueSize / 2000);

            const processTasks = [];
            while (this.videoFrames.length) {
                const frame = this.videoFrames.shift();
                document.getElementById('status').textContent = `Analyzing ${(frame.timestamp/1000000).toFixed(2)}/${(this.videoDurationUs/1000000).toFixed(2)}`;
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

        return votes.indexOf(Math.max(...votes));
    }
} 