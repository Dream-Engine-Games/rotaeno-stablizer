/**
 * Main application script for Rotaeno Stabilizer
 */

import { Lock } from './modules/utils.js';
import { TranslationManager, translations } from './modules/translations.js';
import { FileManager } from './modules/file-operations.js';
import { VideoProcessor } from './modules/video-processor.js';
import { Renderer } from './modules/renderer.js';
import { CodecManager } from './modules/codec-manager.js';
import { UIManager } from './modules/ui-handlers.js';
import { VideoEncoder } from './modules/encoder.js';

window.onload = async function() {
    // Make translations available globally for components that need it
    window.translation = translations.en;
    
    // Initialize LibAV
    const libav = await LibAV.LibAV({noworker: true, nowasm: true});
    libav.avpPkt = libav.av_packet_alloc_sync();
    libav.avpPktW = libav.av_packet_alloc_sync();
    
    // Check browser compatibility
    checkBrowserCompatibility();
    
    // Initialize modules
    const translationManager = new TranslationManager();
    const fileManager = new FileManager(libav);
    const videoProcessor = new VideoProcessor(libav, fileManager);
    const renderer = new Renderer();
    const codecManager = new CodecManager();
    const uiManager = new UIManager(videoProcessor, renderer, codecManager, translationManager);
    const videoEncoder = new VideoEncoder(libav, videoProcessor, fileManager, renderer);
    
    // Set up encoding function
    window.encodeVideo = async function() {
        const config = uiManager.getParameters();
        await videoEncoder.encodeVideo(config);
    };
    
    // Start at the first step
    uiManager.goToStep(0);
};

/**
 * Check browser compatibility and show warnings if needed
 */
function checkBrowserCompatibility() {
    const featureCheck = {
        secureContext: () => isSecureContext,
        resizableArrayBuffer: () => new ArrayBuffer(0, {maxByteLength: 1024}).resize(1024) || true,
        webCodecs: () => window.VideoEncoder && window.VideoDecoder,
        offscreenCanvas: () => new OffscreenCanvas(16, 16).getContext('2d'),
        notTbsBrowser: () => navigator.userAgent.indexOf(' TBS/') < 0,
    };
    
    let failedChecks = [];
    for (const feature in featureCheck) {
        try {
            if(featureCheck[feature]()) continue;
        } catch {}
        failedChecks.push(feature);
    }

    if (failedChecks.length) {
        const translation = window.translation || { compatabilityWarning: 'This browser is too old or lacking features.' };
        alert(translation.compatabilityWarning + ' ' + failedChecks.join(', '));
    }
} 