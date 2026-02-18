// Transcribe audio files using Azure AI Speech SDK (Node.js)
// Supports long audio via continuous recognition (no 60s limit)
// OGG/MP3/etc. are converted to WAV PCM 16kHz mono via ffmpeg-static first.
// Usage: node src/scripts/transcribe_audio.js [file1.ogg file2.ogg ...]
//        (if no args, processes all files in data/audio/)

require('dotenv').config();
const sdk = require('microsoft-cognitiveservices-speech-sdk');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const ffmpegPath = require('ffmpeg-static');

const SPEECH_KEY    = process.env.AZURE_SPEECH_KEY;
const SPEECH_REGION = process.env.AZURE_SPEECH_REGION || 'swedencentral';
const LANGUAGE      = 'es-ES';
const AUDIO_DIR     = path.join(__dirname, '../../data/audio');
const OUT_DIR       = path.join(__dirname, '../../data/audio');

if (!SPEECH_KEY) {
    console.error('ERROR: AZURE_SPEECH_KEY not set in .env');
    process.exit(1);
}

// Determine files to process
let files;
if (process.argv.length > 2) {
    files = process.argv.slice(2).map(f => path.resolve(f));
} else {
    files = fs.readdirSync(AUDIO_DIR)
        .filter(f => /\.(ogg|wav|mp3|flac|m4a|webm)$/i.test(f))
        .map(f => path.join(AUDIO_DIR, f));
}

if (files.length === 0) {
    console.log('No audio files found.');
    process.exit(0);
}

/**
 * Convert any audio file to WAV PCM 16kHz mono using ffmpeg-static.
 * Returns a Buffer with the WAV bytes.
 */
function toWavBuffer(filePath) {
    // -f wav: output format WAV
    // -ar 16000: 16 kHz sample rate (Speech API preferred)
    // -ac 1: mono
    // -acodec pcm_s16le: 16-bit PCM
    // pipe:1: output to stdout
    return execFileSync(ffmpegPath, [
        '-y', '-i', filePath,
        '-f', 'wav',
        '-ar', '16000',
        '-ac', '1',
        '-acodec', 'pcm_s16le',
        'pipe:1',
    ], { maxBuffer: 50 * 1024 * 1024 }); // up to 50 MB
}

/**
 * Transcribe a single audio file using continuous recognition.
 * Returns the full transcribed text.
 */
function transcribeFile(filePath) {
    return new Promise((resolve, reject) => {
        // Convert to WAV PCM first (handles OGG, MP3, M4A, etc.)
        let wavBuffer;
        try {
            process.stdout.write(`  Convirtiendo a WAV PCM 16kHz…\n`);
            wavBuffer = toWavBuffer(filePath);
            process.stdout.write(`  WAV: ${(wavBuffer.length / 1024).toFixed(0)} KB\n`);
        } catch (e) {
            return reject(new Error(`ffmpeg conversion failed: ${e.message}`));
        }

        const speechConfig = sdk.SpeechConfig.fromSubscription(SPEECH_KEY, SPEECH_REGION);
        speechConfig.speechRecognitionLanguage = LANGUAGE;
        // Request detailed output to get the best candidate
        speechConfig.outputFormat = sdk.OutputFormat.Detailed;

        const audioConfig = sdk.AudioConfig.fromWavFileInput(wavBuffer);
        const recognizer = new sdk.SpeechRecognizer(speechConfig, audioConfig);

        const segments = [];

        recognizer.recognized = (_, e) => {
            if (e.result.reason === sdk.ResultReason.RecognizedSpeech) {
                const text = e.result.text.trim();
                if (text) {
                    segments.push(text);
                    process.stdout.write(`  › ${text}\n`);
                }
            } else if (e.result.reason === sdk.ResultReason.NoMatch) {
                // silence / no speech detected in this segment — skip
            }
        };

        recognizer.canceled = (_, e) => {
            if (e.reason === sdk.CancellationReason.Error) {
                recognizer.stopContinuousRecognitionAsync();
                reject(new Error(`Speech SDK error ${e.errorCode}: ${e.errorDetails}`));
            } else {
                // EndOfStream — natural end
                recognizer.stopContinuousRecognitionAsync();
            }
        };

        recognizer.sessionStopped = () => {
            recognizer.stopContinuousRecognitionAsync(() => {
                resolve(segments.join(' '));
            });
        };

        recognizer.startContinuousRecognitionAsync(
            () => { /* started */ },
            (err) => reject(new Error(`Failed to start recognition: ${err}`))
        );
    });
}

(async () => {
    for (const filePath of files) {
        const name = path.basename(filePath);
        console.log(`\n━━━ ${name} ━━━`);

        try {
            const text = await transcribeFile(filePath);
            console.log(`\nTRANSCRIPCIÓN COMPLETA:\n${text}`);

            // Save to .txt next to the audio file
            const outPath = path.join(OUT_DIR, path.basename(filePath, path.extname(filePath)) + '.txt');
            fs.writeFileSync(outPath, text, 'utf8');
            console.log(`\nGuardado en: ${outPath}`);
        } catch (err) {
            console.error(`ERROR procesando ${name}: ${err.message}`);
        }
    }
})();
