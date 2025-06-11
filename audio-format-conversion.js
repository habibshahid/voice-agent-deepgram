// audio-format-conversion.js - Handles audio format conversion between Asterisk and Deepgram

/**
 * G.711 μ-law to linear PCM conversion tables
 * These tables speed up conversion
 */
const MULAW_TO_LINEAR_TABLE = new Int16Array(256);

// Initialize the conversion table
(function initMulawTable() {
    for (let i = 0; i < 256; i++) {
        const mulaw = i ^ 0xFF; // Invert bits
        
        let sign = (mulaw & 0x80) ? -1 : 1;
        let exponent = (mulaw >> 4) & 0x07;
        let mantissa = mulaw & 0x0F;
        
        let sample = mantissa << (exponent + 3);
        sample += 132;
        sample *= sign;
        
        MULAW_TO_LINEAR_TABLE[i] = sample;
    }
})();

/**
 * Convert G.711 μ-law audio to 16-bit linear PCM
 * @param {Buffer} mulawData - μ-law encoded audio
 * @param {Object} options - Conversion options
 * @returns {Buffer} - Linear PCM audio
 */
function mulawToLinear(mulawData, options = {}) {
    const {
        inputSampleRate = 8000,
        outputSampleRate = 16000
    } = options;
    
    // Convert μ-law to linear PCM
    const linearData = Buffer.alloc(mulawData.length * 2);
    
    for (let i = 0; i < mulawData.length; i++) {
        const sample = MULAW_TO_LINEAR_TABLE[mulawData[i]];
        linearData.writeInt16LE(sample, i * 2);
    }
    
    // If sample rates match, return as is
    if (inputSampleRate === outputSampleRate) {
        return linearData;
    }
    
    // Otherwise, resample
    return resampleAudio(linearData, inputSampleRate, outputSampleRate);
}

/**
 * Convert 16-bit linear PCM audio to G.711 μ-law
 * @param {Buffer} linearData - Linear PCM audio
 * @param {Object} options - Conversion options
 * @returns {Buffer} - μ-law encoded audio
 */
function linearToMulaw(linearData, options = {}) {
    const {
        inputSampleRate = 16000,
        outputSampleRate = 8000
    } = options;
    
    // Resample if needed
    const resampledData = inputSampleRate !== outputSampleRate
        ? resampleAudio(linearData, inputSampleRate, outputSampleRate)
        : linearData;
    
    // Convert linear PCM to μ-law
    const mulawData = Buffer.alloc(resampledData.length / 2);
    
    for (let i = 0; i < mulawData.length; i++) {
        const sample = resampledData.readInt16LE(i * 2);
        mulawData[i] = linearToMulawSample(sample);
    }
    
    return mulawData;
}

/**
 * Convert a 16-bit linear PCM sample to μ-law
 * @param {number} sample - Linear PCM sample
 * @returns {number} - μ-law encoded sample
 */
function linearToMulawSample(sample) {
    // Clamp sample to valid range
    sample = Math.max(-32768, Math.min(32767, sample));
    
    // Get sign and magnitude
    const sign = sample < 0 ? 0x80 : 0;
    if (sample < 0) sample = -sample;
    
    // Add bias
    sample += 132;
    
    // Compute segment and quantization
    let exponent = 0;
    for (let i = 0; i < 8; i++) {
        if (sample <= (0xFFF >> i)) {
            exponent = i;
            break;
        }
    }
    
    let mantissa;
    if (exponent === 0) {
        mantissa = sample >> 4;
    } else {
        mantissa = (sample >> (exponent + 3)) & 0x0F;
    }
    
    // Compute μ-law value
    let mulaw = sign | (exponent << 4) | mantissa;
    
    // Invert bits (standard for μ-law)
    return mulaw ^ 0xFF;
}

/**
 * Resample audio from one sample rate to another
 * This is a simple linear interpolation - for better quality use a library
 * @param {Buffer} audioData - 16-bit linear PCM audio
 * @param {number} inputSampleRate - Input sample rate
 * @param {number} outputSampleRate - Output sample rate
 * @returns {Buffer} - Resampled audio
 */
function resampleAudio(audioData, inputSampleRate, outputSampleRate) {
    // If rates are the same, return as is
    if (inputSampleRate === outputSampleRate) {
        return audioData;
    }
    
    // Calculate output size
    const inputSamples = audioData.length / 2;
    const outputSamples = Math.ceil(inputSamples * outputSampleRate / inputSampleRate);
    const outputData = Buffer.alloc(outputSamples * 2);
    
    // Resample using linear interpolation
    for (let i = 0; i < outputSamples; i++) {
        const inputIndex = i * inputSampleRate / outputSampleRate;
        const inputIndexFloor = Math.floor(inputIndex);
        const inputIndexCeil = Math.min(inputSamples - 1, Math.ceil(inputIndex));
        const t = inputIndex - inputIndexFloor;
        
        if (inputIndexFloor === inputIndexCeil) {
            // Exact sample
            outputData.writeInt16LE(audioData.readInt16LE(inputIndexFloor * 2), i * 2);
        } else {
            // Interpolate
            const sample1 = audioData.readInt16LE(inputIndexFloor * 2);
            const sample2 = audioData.readInt16LE(inputIndexCeil * 2);
            const sample = Math.round(sample1 * (1 - t) + sample2 * t);
            
            outputData.writeInt16LE(sample, i * 2);
        }
    }
    
    return outputData;
}

/**
 * Strip WAV header from audio data
 * @param {Buffer} audioData - Audio data possibly with WAV header
 * @returns {Buffer} - Audio data without WAV header
 */
function stripWavHeader(audioData) {
    // Check if this is a WAV file (starts with RIFF header)
    if (audioData.length > 44 && 
        audioData[0] === 0x52 && audioData[1] === 0x49 && 
        audioData[2] === 0x46 && audioData[3] === 0x46) {
        
        // Skip the 44-byte WAV header
        return audioData.slice(44);
    }
    
    // Not a WAV file, return as is
    return audioData;
}

module.exports = {
    mulawToLinear,
    linearToMulaw,
    stripWavHeader,
    resampleAudio
};