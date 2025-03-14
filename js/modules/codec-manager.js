/**
 * Codec Manager module for Rotaeno Stabilizer
 */

/**
 * Codec profiles and configurations
 */
const codecProfiles = {
    avc1: {
        levels: [
            [30, 1620, 40500],
            [31, 3600, 108000],
            [32, 5120, 216000],
            [40, 8192, 245760],
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
            return r;
        }
    },
    hvc1: {
        levels: [
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
            [4, 665856/256, 19975680/256],
            [5, 1065024/256, 31950720/256],
            [8, 2359296/256, 70778880/256],
            [9, 2359296/256, 141557760/256],
            [12, 8912896/256, 267386880/256],
            [13, 8912896/256, 534773760/256],
            [14, 8912896/256, 1069547520/256],
            [16, 35651584/256, 1069547520/256],
            [17, 35651584/256, 2139095040/256],
            [18, 35651584/256, 4278190080/256],
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

/**
 * CodecManager class for handling video codec detection and configuration
 */
export class CodecManager {
    /**
     * Find supported codecs for the given dimensions and framerate
     * @param {number} w - Width
     * @param {number} h - Height
     * @param {number} fps - Frames per second
     * @returns {Promise<Array>} - Array of supported codec configurations
     */
    async findCodecs(w, h, fps) {
        w = Math.ceil(w/16)*16;
        h = Math.ceil(h/16)*16;
        const mbps = w*h*fps/256;

        const supportedConfigs = [];
        for (const codec in codecProfiles) {
            let supMbFrame = null, supMbSpeed = null;
            const supportedLevels = [];
            for (const [level, mbFrame, mbSpeed] of codecProfiles[codec].levels) {
                if (w*h/256 > mbFrame) continue;
                if (mbps > mbSpeed) continue;
                if (mbSpeed !== (supMbSpeed ??= mbSpeed)) break;
                if (mbFrame !== (supMbFrame ??= mbFrame)) break;
                supportedLevels.push(level);
            }

            let configs = [[]];
            if (codecProfiles[codec].tiers && codecProfiles[codec].profiles) {
                configs.pop();
                for (const tier of codecProfiles[codec].tiers) {
                    for (const profile of codecProfiles[codec].profiles) {
                        configs.push([profile, tier]);
                    }
                }
            } else if (codecProfiles[codec].tiers) {
                configs = codecProfiles[codec].tiers.map(v => [v]);
            } else if (codecProfiles[codec].profiles) {
                configs = codecProfiles[codec].profiles.map(v => [v]);
            }

            for (const level of supportedLevels) {
                for (const config of configs) {
                    const codecStr = codecProfiles[codec].format(level, ...config);
                    if((await VideoEncoder.isConfigSupported({codec: codecStr, width: w, height: h, framerate: 30, bitrateMode: 'variable'})).supported) {
                        supportedConfigs.push(codecStr);
                    }
                }
            }
        }

        return supportedConfigs.map(cfg => {
            const codec = cfg.split('.')[0];
            return {codec: cfg, desc: codecProfiles[codec].describe(cfg)};
        });
    }

    /**
     * Update the codec selection dropdown with supported codecs
     * @param {Object} config - Current configuration
     * @param {number} peakFramerate - Peak framerate detected
     */
    async updateCodecs(config, peakFramerate) {
        const codecs = await this.findCodecs(config.outputDim, config.outputDim, peakFramerate ? peakFramerate : 120);
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
    }
} 