/**
 * Translations module for Rotaeno Stabilizer
 */

/**
 * Translation data for different languages
 */
export const translations = {
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
        credit4: 'Based on <a href="https://github.com/linnaea/rotaeno-stablizer">linnaea/rotaeno-stablizer</a> for web',
    }
};

/**
 * Translation manager class
 */
export class TranslationManager {
    constructor() {
        this.currentTranslation = translations.en;
        this.initializeTranslation();
        this.setupLanguageChangeListener();
    }

    /**
     * Initialize translation based on browser language
     */
    initializeTranslation() {
        for (const language of navigator.languages) {
            let trans = translations[language] ?? translations[language.split('-')[0]];
            if (trans) {
                this.currentTranslation = trans;
                this.updateAllElements();
                break;
            }
        }
    }

    /**
     * Set up listener for language change events
     */
    setupLanguageChangeListener() {
        document.getElementById('languageChange')?.addEventListener('change', () => {
            const lang = document.documentElement.lang;
            this.currentTranslation = translations[lang] || 
                                      translations[lang.split('-')[0]] || 
                                      translations.en;
            
            this.updateAllElements();
            this.updateStepIndicator();
        });
    }

    /**
     * Update all text elements with current translation
     */
    updateAllElements() {
        for (const key in this.currentTranslation) {
            let element = document.getElementById(key);
            element = (element?.labels?.[0] ?? element);
            if (element) {
                element.innerHTML = this.currentTranslation[key];
            }
        }
    }

    /**
     * Update step indicator with current language
     */
    updateStepIndicator() {
        if (typeof window.updateStepIndicator === 'function') {
            const steps = ['FILE', 'CROP', 'CODE_BLOCK', 'ORIENTATION', 'RING', 'TRIM', 'CODEC', 'OUTPUT'];
            const stepDivs = document.querySelectorAll('div[data-step]');
            
            for (let i = 0; i < stepDivs.length; i++) {
                if (stepDivs[i].style.display === 'block') {
                    const stepIndex = steps.indexOf(stepDivs[i].dataset.step);
                    if (stepIndex !== -1) {
                        window.updateStepIndicator(stepIndex);
                    }
                    break;
                }
            }
        }
    }

    /**
     * Get current translation
     * @returns {Object} Current translation object
     */
    getTranslation() {
        return this.currentTranslation;
    }
} 