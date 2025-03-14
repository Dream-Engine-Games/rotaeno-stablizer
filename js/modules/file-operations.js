/**
 * File Operations module for Rotaeno Stabilizer
 */

/**
 * FileManager class for handling file operations
 */
export class FileManager {
    /**
     * Initialize the file manager
     * @param {Object} libav - LibAV instance
     */
    constructor(libav) {
        this.libav = libav;
        this.currentFile = null;
        this.outputFile = null;
        this.outputUrl = null;
        this.outputChunks = null;
        this.outputChunkSize = 33554432; // 32MB

        this.setupLibavHandlers();
    }

    /**
     * Set up LibAV handlers for file operations
     */
    setupLibavHandlers() {
        // Set up block read handler
        this.libav.onblockread = async (filename, pos, length) => {
            if (!this.currentFile || filename !== this.currentFile.name) {
                await this.libav.ff_block_reader_dev_send(filename, pos, null, {errorCode: this.libav.EIO});
            } else {
                await this.libav.ff_block_reader_dev_send(filename, pos,
                    new Uint8Array(await this.currentFile.slice(pos, pos+length).arrayBuffer()));
            }
        };

        // Set up write handler
        this.libav.onwrite = async (filename, pos, data) => {
            if (filename !== this.outputFile) return;
            this.outputChunks ??= [];

            const startChunk = Math.floor(pos / this.outputChunkSize);
            while (startChunk >= this.outputChunks.length)
                this.outputChunks.push(new ArrayBuffer(0, {maxByteLength: this.outputChunkSize}));

            if (this.outputChunks[startChunk] instanceof Blob)
                this.outputChunks[startChunk] = await this.outputChunks[startChunk].arrayBuffer();

            const chunkPos = pos % this.outputChunkSize;
            const chunkLen = this.outputChunkSize - chunkPos;
            const writeLen = Math.min(chunkLen, data.length);
            if (this.outputChunks[startChunk].byteLength < chunkPos + writeLen) {
                if (!this.outputChunks[startChunk].resizable) {
                    const newData = new ArrayBuffer(chunkPos + writeLen, {maxByteLength: this.outputChunkSize});
                    new Uint8Array(newData).set(new Uint8Array(this.outputChunks[startChunk]));
                    this.outputChunks[startChunk] = newData;
                } else {
                    this.outputChunks[startChunk].resize(chunkPos + writeLen);
                }
            }

            new Uint8Array(this.outputChunks[startChunk], chunkPos).set(data.subarray(0, writeLen));
            if (startChunk > 0 && startChunk < this.outputChunks.length - 1)
                if (this.outputChunks[startChunk].length === this.outputChunkSize)
                    this.outputChunks[startChunk] = new Blob([this.outputChunks[startChunk]]);

            if (data.length > writeLen)
                await this.libav.onwrite(filename, pos + writeLen, data.subarray(writeLen));
        };
    }

    /**
     * Set the current input file
     * @param {File} file - Input file
     */
    setCurrentFile(file) {
        this.currentFile = file;
    }

    /**
     * Create a new output file
     * @param {string} codecType - Codec type to determine file extension
     * @param {Object} iaStream - Audio stream information
     * @returns {string} - Output file name
     */
    createOutputFile(codecType, iaStream) {
        if (this.outputUrl) URL.revokeObjectURL(this.outputUrl);
        if (this.outputFile) this.libav.unlink_sync(this.outputFile);
        
        this.outputUrl = null;
        this.outputChunks = [];
        this.outputFile = new Date().getTime().toString() + '.';
        
        switch (codecType) {
            case 'av01':
            case 'vp09':
            case 'vp8':
                // 0x15005 - AV_CODEC_ID_VORBIS
                // 0x1503c - AV_CODEC_ID_OPUS
                if (!iaStream || iaStream.codec_id === 0x1503c || iaStream.codec_id === 0x15005)
                    this.outputFile += 'webm';
                break;

            case 'avc1':
            case 'hvc1':
                if (!iaStream)
                    this.outputFile += 'mp4';
                else if (this.isMP4CompatibleAudio(iaStream.codec_id)) {
                    this.outputFile += 'mp4';
                }
                break;
        }

        if (this.outputFile.endsWith('.'))
            this.outputFile += 'mkv';

        this.libav.mkwriterdev_sync(this.outputFile);
        return this.outputFile;
    }

    /**
     * Check if audio codec is compatible with MP4 container
     * @param {number} codecId - Audio codec ID
     * @returns {boolean} - True if compatible
     */
    isMP4CompatibleAudio(codecId) {
        const mp4CompatibleCodecs = [
            0x15000+442-440, // AV_CODEC_ID_AAC
            0x15000+443-440, // AV_CODEC_ID_AC3
            0x15000+543-440, // AV_CODEC_ID_AC4
            0x15000+456-440, // AV_CODEC_ID_ALAC
            0x15000+444-440, // AV_CODEC_ID_DTS
            0x15000+480-440, // AV_CODEC_ID_EAC3
            0x15000+446-440, // AV_CODEC_ID_DVAUDIO
            0x15000+458-440, // AV_CODEC_ID_GSM
            0x15000+499-440, // AV_CODEC_ID_ILBC
            0x15000+449-440, // AV_CODEC_ID_MACE3
            0x15000+450-440, // AV_CODEC_ID_MACE6
            0x15000+482-440, // AV_CODEC_ID_MP1
            0x15000+440-440, // AV_CODEC_ID_MP2
            0x15000+441-440, // AV_CODEC_ID_MP3
            0x15000+473-440, // AV_CODEC_ID_NELLYMOSER
            0x15000+464-440, // AV_CODEC_ID_QCELP
            0x15000+459-440, // AV_CODEC_ID_QDM2
            0x15000+490-440, // AV_CODEC_ID_QDMC
            0x15000+475-440, // AV_CODEC_ID_SPEEX
            0x15000+511-440, // AV_CODEC_ID_EVRC
            0x15000+512-440, // AV_CODEC_ID_SMV
            0x15000+452-440, // AV_CODEC_ID_FLAC
            0x15000+484-440, // AV_CODEC_ID_TRUEHD
            0x15000+500-440, // AV_CODEC_ID_OPUS
            0x15000+531-440, // AV_CODEC_ID_MPEGH_3D_AUDIO
            0x12000, // AV_CODEC_ID_AMR_NB
            0x12001, // AV_CODEC_ID_AMR_WB
            0x11000, // AV_CODEC_ID_ADPCM_IMA_QT
            0x10000+334-328, // AV_CODEC_ID_PCM_MULAW
            0x10000+335-328, // AV_CODEC_ID_PCM_ALAW
            0x10000+348-328, // AV_CODEC_ID_PCM_F32BE
            0x10000+349-328, // AV_CODEC_ID_PCM_F32LE
            0x10000+350-328, // AV_CODEC_ID_PCM_F64BE
            0x10000+351-328, // AV_CODEC_ID_PCM_F64LE
            0x10000+329-328, // AV_CODEC_ID_PCM_S16BE
            0x10000+328-328, // AV_CODEC_ID_PCM_S16LE
            0x10000+341-328, // AV_CODEC_ID_PCM_S24BE
            0x10000+340-328, // AV_CODEC_ID_PCM_S24LE
            0x10000+337-328, // AV_CODEC_ID_PCM_S32BE
            0x10000+336-328, // AV_CODEC_ID_PCM_S32LE
            0x10000+332-328, // AV_CODEC_ID_PCM_S8
            0x10000+333-328, // AV_CODEC_ID_PCM_U8
        ];
        
        return mp4CompatibleCodecs.includes(codecId);
    }

    /**
     * Finalize the output file and create a download link
     * @param {string} mimeType - MIME type for the output file
     * @returns {string} - URL for the output file
     */
    finalizeOutput(mimeType) {
        for (let i = 0; i < this.outputChunks.length; i++) {
            if (this.outputChunks[i] instanceof ArrayBuffer && this.outputChunks[i].resizable) {
                const data = this.outputChunks[i];
                this.outputChunks[i] = new ArrayBuffer((i === (this.outputChunks.length-1)) ? data.byteLength : this.outputChunkSize);
                new Uint8Array(this.outputChunks[i]).set(new Uint8Array(data));
            }
        }

        const outputBlob = new Blob(this.outputChunks, { type: mimeType || this.getMimeType() });
        this.outputChunks = [outputBlob];
        this.outputUrl = URL.createObjectURL(outputBlob);
        
        // Update download link
        const downloadLink = document.getElementById('download');
        if (downloadLink) {
            downloadLink.href = this.outputUrl;
            downloadLink.setAttribute('download', this.outputFile);
        }
        
        return this.outputUrl;
    }

    /**
     * Get MIME type based on file extension
     * @returns {string} - MIME type
     */
    getMimeType() {
        if (this.outputFile.endsWith('.mkv')) return 'video/matroska';
        if (this.outputFile.endsWith('.mp4')) return 'video/mp4';
        if (this.outputFile.endsWith('.webm')) return 'video/webm';
        return 'application/octet-stream';
    }
} 