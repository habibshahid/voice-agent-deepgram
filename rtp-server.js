// rtp-server.js - Handles RTP audio streaming for Asterisk External Media

const dgram = require('dgram');
const EventEmitter = require('events');
const debug = require('debug')('rtp-server');

class RtpServer extends EventEmitter {
    constructor(options = {}) {
        super();
        
        this.options = {
            port: options.port || 10000,
            host: options.host || '0.0.0.0',
            payloadType: options.payloadType || 0, // 0 = PCMU, 8 = PCMA
            sampleRate: options.sampleRate || 8000,
            channels: options.channels || 1,
            ...options
        };
        
        this.socket = null;
        this.isRunning = false;
        this.clients = new Map(); // remoteAddress:remotePort -> {timestamp, packets}
        
        // Stats
        this.stats = {
            packetsReceived: 0,
            packetsSent: 0,
            bytesReceived: 0,
            bytesSent: 0,
            startTime: Date.now()
        };
        
        // Sequence number for outgoing RTP packets
        this.sequenceNumber = Math.floor(Math.random() * 65535);
        this.timestamp = Math.floor(Math.random() * 0xFFFFFFFF);
        this.ssrc = Math.floor(Math.random() * 0xFFFFFFFF);
    }
    
    /**
     * Start the RTP server
     * @returns {Promise<void>}
     */
    start() {
        return new Promise((resolve, reject) => {
            if (this.isRunning) {
                return resolve();
            }
            
            this.socket = dgram.createSocket('udp4');
            
            this.socket.on('error', (err) => {
                console.error(`RTP server error: ${err.message}`);
                this.emit('error', err);
                
                if (!this.isRunning) {
                    reject(err);
                }
            });
            
            this.socket.on('message', (msg, rinfo) => {
                this.handleRtpPacket(msg, rinfo);
            });
            
            this.socket.on('listening', () => {
                const address = this.socket.address();
                debug(`RTP server listening on ${address.address}:${address.port}`);
                this.isRunning = true;
                this.emit('listening', address);
                
                // Start stats reporting
                this.statsInterval = setInterval(() => this.reportStats(), 10000);
                
                resolve();
            });
            
            this.socket.bind(this.options.port, this.options.host);
        });
    }
    
    /**
     * Stop the RTP server
     */
    stop() {
        if (!this.isRunning) {
            return;
        }
        
        if (this.statsInterval) {
            clearInterval(this.statsInterval);
            this.statsInterval = null;
        }
        
        if (this.socket) {
            this.socket.close();
            this.socket = null;
        }
        
        this.isRunning = false;
        this.clients.clear();
        debug('RTP server stopped');
        this.emit('stopped');
    }
    
    /**
     * Handle incoming RTP packet
     * @param {Buffer} packet - RTP packet
     * @param {Object} rinfo - Remote info (address, port)
     */
    handleRtpPacket(packet, rinfo) {
        if (packet.length < 12) {
            debug(`Received too short packet (${packet.length} bytes) from ${rinfo.address}:${rinfo.port}`);
            return;
        }
        
        // Update stats
        this.stats.packetsReceived++;
        this.stats.bytesReceived += packet.length;
        
        // Track client
        const clientId = `${rinfo.address}:${rinfo.port}`;
        if (!this.clients.has(clientId)) {
            debug(`New RTP client connected: ${clientId}`);
            this.clients.set(clientId, {
                address: rinfo.address,
                port: rinfo.port,
                timestamp: Date.now(),
                packets: 0
            });
            
            this.emit('client-connected', {
                address: rinfo.address,
                port: rinfo.port
            });
        }
        
        // Update client stats
        const client = this.clients.get(clientId);
        client.timestamp = Date.now();
        client.packets++;
        
        // Parse RTP header
        const version = (packet[0] >> 6) & 0x03;
        const padding = (packet[0] >> 5) & 0x01;
        const extension = (packet[0] >> 4) & 0x01;
        const csrcCount = packet[0] & 0x0F;
        const marker = (packet[1] >> 7) & 0x01;
        const payloadType = packet[1] & 0x7F;
        const sequenceNumber = (packet[2] << 8) | packet[3];
        const timestamp = (packet[4] << 24) | (packet[5] << 16) | (packet[6] << 8) | packet[7];
        const ssrc = (packet[8] << 24) | (packet[9] << 16) | (packet[10] << 8) | packet[11];
        
        // Extract payload (audio data)
        const headerLength = 12 + (csrcCount * 4);
        const payload = packet.subarray(headerLength);
        
        // Emit audio data event
        this.emit('audio-data', {
            clientId,
            payloadType,
            timestamp,
            sequenceNumber,
            marker,
            data: payload
        });
    }
    
    /**
     * Send audio data to a client
     * @param {Buffer} audioData - Raw audio data (PCM)
     * @param {Object} target - Target client (address, port)
     */
    sendAudioData(audioData, target) {
        if (!this.isRunning || !this.socket) {
            debug('Cannot send audio: server not running');
            return false;
        }
        
        if (!target || !target.address || !target.port) {
            debug('Cannot send audio: invalid target');
            return false;
        }
        
        // Create RTP packet
        const headerLength = 12; // Standard RTP header
        const packet = Buffer.alloc(headerLength + audioData.length);
        
        // Version = 2, Padding = 0, Extension = 0, CSRC count = 0
        packet[0] = 0x80;
        
        // Marker = 0, Payload type = this.options.payloadType
        packet[1] = this.options.payloadType;
        
        // Sequence number (16 bits)
        packet[2] = (this.sequenceNumber >> 8) & 0xFF;
        packet[3] = this.sequenceNumber & 0xFF;
        this.sequenceNumber = (this.sequenceNumber + 1) % 65536;
        
        // Timestamp (32 bits)
        packet[4] = (this.timestamp >> 24) & 0xFF;
        packet[5] = (this.timestamp >> 16) & 0xFF;
        packet[6] = (this.timestamp >> 8) & 0xFF;
        packet[7] = this.timestamp & 0xFF;
        this.timestamp = (this.timestamp + audioData.length) % 0xFFFFFFFF;
        
        // SSRC (32 bits)
        packet[8] = (this.ssrc >> 24) & 0xFF;
        packet[9] = (this.ssrc >> 16) & 0xFF;
        packet[10] = (this.ssrc >> 8) & 0xFF;
        packet[11] = this.ssrc & 0xFF;
        
        // Copy audio data
        audioData.copy(packet, headerLength);
        
        // Send packet
        this.socket.send(packet, 0, packet.length, target.port, target.address, (err) => {
            if (err) {
                debug(`Error sending RTP packet to ${target.address}:${target.port}: ${err.message}`);
                return;
            }
            
            // Update stats
            this.stats.packetsSent++;
            this.stats.bytesSent += packet.length;
        });
        
        return true;
    }
    
    /**
     * Report server statistics
     */
    reportStats() {
        const now = Date.now();
        const elapsedSec = (now - this.stats.startTime) / 1000;
        
        debug('RTP Server Statistics:');
        debug(`- Uptime: ${Math.floor(elapsedSec)} seconds`);
        debug(`- Clients: ${this.clients.size}`);
        debug(`- Packets received: ${this.stats.packetsReceived}`);
        debug(`- Packets sent: ${this.stats.packetsSent}`);
        debug(`- Bytes received: ${this.stats.bytesReceived}`);
        debug(`- Bytes sent: ${this.stats.bytesSent}`);
        debug(`- Receive rate: ${Math.round(this.stats.bytesReceived / elapsedSec / 1024)} KB/s`);
        debug(`- Send rate: ${Math.round(this.stats.bytesSent / elapsedSec / 1024)} KB/s`);
        
        // Reset stats
        this.stats.packetsReceived = 0;
        this.stats.packetsSent = 0;
        this.stats.bytesReceived = 0;
        this.stats.bytesSent = 0;
        this.stats.startTime = now;
    }
}

module.exports = RtpServer;