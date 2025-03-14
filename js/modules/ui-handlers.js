/**
 * UI Handlers module for Rotaeno Stabilizer
 */

import { Lock } from './utils.js';

/**
 * UIManager class for handling UI interactions and updates
 */
export class UIManager {
    /**
     * Initialize the UI manager
     * @param {Object} videoProcessor - Video processor instance
     * @param {Object} renderer - Renderer instance
     * @param {Object} codecManager - Codec manager instance
     * @param {Object} translationManager - Translation manager instance
     */
    constructor(videoProcessor, renderer, codecManager, translationManager) {
        this.videoProcessor = videoProcessor;
        this.renderer = renderer;
        this.codecManager = codecManager;
        this.translationManager = translationManager;
        this.currentStep = 0;
        this.seekLock = new Lock();
        this.config = null;
        
        this.ALL_STEPS = [
            'FILE',
            'CROP',
            'CODE_BLOCK',
            'ORIENTATION',
            'RING',
            'TRIM',
            'CODEC',
            'OUTPUT'
        ];
        
        // Create a mapping of step names to indices
        for (let i = 0; i < this.ALL_STEPS.length; i++) {
            this.ALL_STEPS[this.ALL_STEPS[i]] = i;
        }
        
        this.setupEventListeners();
    }

    /**
     * Set up event listeners for UI elements
     */
    setupEventListeners() {
        // Set up event listeners for realtime update elements
        for (const cfgOption of document.querySelectorAll('div.realtime-update input, div.realtime-update select')) {
            cfgOption.onchange = () => this.updatePreview();
        }

        // Set up event listener for output dimension
        document.getElementById('outputDim').onchange = async () => {
            document.getElementById('outputDim').value = Math.floor(document.getElementById('outputDim').value / 16) * 16;
            await this.updatePreview();
            await this.codecManager.updateCodecs(this.config, this.videoProcessor.peakFramerate);
        };

        // Set up event listener for next step button
        document.getElementById('btnNextStep').onclick = () => {
            this.goToStep(this.currentStep + 1);
        };

        // Set up event listener for file input
        document.getElementById('inputFile').onchange = async () => {
            document.getElementById('status').textContent = 'Loading';
            const file = document.getElementById('inputFile').files[0];
            
            if (await this.videoProcessor.initializeDecoder(file)) {
                document.getElementById('seekPosition').dispatchEvent(new Event("change"));
                this.goToStep(1);
            } else {
                document.getElementById('status').textContent = 'Error loading file';
            }
        };

        // Set up event listener for seek position
        document.getElementById('seekPosition').addEventListener('change', async function() {
            const seekPos = parseFloat(this.value) * 1000000;
            await this.videoProcessor.seekToPosition(seekPos, this.seekLock);
            await this.updatePreview();
        }.bind(this));

        // Set up event listener for analyze button
        document.getElementById('analyzeBtn').onclick = async () => {
            this.videoProcessor.peakFramerate = 0;
            this.config = this.getParameters();

            document.getElementById('status').textContent = 'Analyzing';
            
            // Estimate crop values
            const cropValues = await this.videoProcessor.estimateCrop(
                this.videoProcessor.ivConfig.codedWidth, 
                this.videoProcessor.ivConfig.codedHeight
            );
            
            document.getElementById('cropL').value = cropValues.cropL;
            document.getElementById('cropR').value = cropValues.cropR;
            document.getElementById('cropT').value = cropValues.cropT;
            document.getElementById('cropB').value = cropValues.cropB;
            
            // Estimate block size
            const blockSize = await this.videoProcessor.estimateBlockSize(
                Math.floor(Math.max(
                    this.videoProcessor.ivConfig.codedWidth, 
                    this.videoProcessor.ivConfig.codedHeight
                ) / 100),
                this.config
            );
            
            document.getElementById('blockSize').value = blockSize;
            
            // Guess orientation
            const orientationIndex = await this.videoProcessor.guessOrientation(
                this.config,
                this.renderer.processFrame.bind(this.renderer)
            );
            
            const options = document.getElementById('orientation').querySelectorAll('option');
            options.forEach((e, i) => e.selected = i === orientationIndex);
            
            // Clear video frames and update preview
            while (this.videoProcessor.videoFrames.length) {
                this.videoProcessor.videoFrames.pop().close();
            }
            
            await this.updatePreview();
            document.getElementById('status').textContent = '';
        };
    }

    /**
     * Get parameters from UI elements
     * @returns {Object} - Configuration parameters
     */
    getParameters() {
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
        };
        
        const p = {};
        for (const key in allParams) {
            p[key] = allParams[key](document.getElementById(key).value);
        }

        this.config = p;
        this.renderer.setConfig(p);
        return p;
    }

    /**
     * Update the preview canvas
     * @returns {Promise<void>}
     */
    async updatePreview() {
        this.config = this.getParameters();
        if (!this.videoProcessor.previewFrame) return;

        const previewCanvas = document.getElementById('preview');
        await this.renderer.updatePreview(
            previewCanvas, 
            this.videoProcessor.previewFrame, 
            this.currentStep
        );
    }

    /**
     * Navigate to a specific step
     * @param {number} n - Step index
     */
    goToStep(n) {
        this.currentStep = n;
        document.getElementById('status').textContent = '';
        document.getElementById('seekControl').style.display = n ? 'block' : 'none';
        document.getElementById('stepControl').style.display = n ? 'block' : 'none';
        
        for (const div of document.querySelectorAll('div[data-step]')) {
            div.style.display = (n === this.ALL_STEPS[div.dataset.step]) ? 'block' : 'none';
        }

        switch(n) {
            case this.ALL_STEPS.OUTPUT:
                // Handle output step
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
                
            case this.ALL_STEPS.RING:
                // Handle ring step
                let frameWidth = this.videoProcessor.previewFrame.width - this.config.cropL - this.config.cropR;
                let frameHeight = this.videoProcessor.previewFrame.height - this.config.cropT - this.config.cropB;
                if (frameHeight > frameWidth) [frameHeight, frameWidth] = [frameWidth, frameHeight];
                const ringRadius = (frameWidth * 3 / frameHeight > 7) ? frameWidth / 7 * 3 : frameHeight;
                document.getElementById('ringRadius').max = frameWidth;
                document.getElementById('ringRadius').value = Math.floor(ringRadius * 1.5575 / 2);
                document.getElementById('ringStroke').value = Math.floor(3 * ringRadius / 328 - 46 / 41);
                break;
                
            case this.ALL_STEPS.TRIM:
                // Handle trim step
                document.getElementById('trimEnd').value = Math.floor(this.videoProcessor.videoDurationUs / 100000) / 10 - 2;
                break;
                
            case this.ALL_STEPS.CODEC:
                // Handle codec step
                this.codecManager.updateCodecs(this.config, this.videoProcessor.peakFramerate);
                break;
        }

        if (n) {
            this.updatePreview();
        }
    }
} 