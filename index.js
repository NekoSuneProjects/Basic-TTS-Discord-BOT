const { Client, GatewayIntentBits, Partials, version: discordjsVersion, ActivityType } = require('discord.js');
const fs = require('fs').promises;
const chalk = require("chalk");
const path = require('path');
const { https } = require('follow-redirects');
const { pipeline } = require('stream');
const util = require('util');
const pipelineAsync = util.promisify(pipeline);
const os = require('os');
const logger = console;
const readline = require('readline');

// Bot configuration directory
const BOT_CONFIG_DIR = 'bot_configs';
const PIPER_DIR = 'piper';
const MODELS_DIR = path.join(PIPER_DIR, 'models');

// Store bot instances
const bots = [];

// Voice model download URLs (from Hugging Face)
const VOICE_MODELS = require('./voice_dl.json');

// Language mapping for TTS configs
const LANGUAGE_MAP = {
    'de_DE': 'German (Germany)',
    'en_US': 'English (United States)',
    'en_GB': 'English (United Kingdom)',
    'es_ES': 'Spanish (Spain)',
    'fr_FR': 'French (France)',
    'sv_SE': 'Swedish (Sweden)',
    'nl_NL': 'Dutch (Netherlands)',
    'da_DK': 'Danish (Denmark)',
    'it_IT': 'Italian (Italy)',
    'ru_RU': 'Russian (Russia)',
    'pt_BR': 'Portuguese (Brazil)',
    'pl_PL': 'Polish (Poland)',
};

// Helper to update bot presence
const setBotPresence = async (activity, client, type = ActivityType.Watching, url = null) => {
  client.user.setPresence({
    activities: [{ name: activity, type, url }],
    status: "dnd",
  });
};

// Rotate presence messages when offline
const rotatePresenceMessages = (client) => {
  const messages = [
    `/help || RAWR! || IM A BIG CUTIE`,
    `/help || Neko TTS BOT || MY MASTER NEKOSUNEVR IS A CUTIE!`,
    `/help || Neko TTS BOT || NOTICE ME SENPAI!! UWU`,
    `/help || NEKO BOT || Serving: ${client.guilds.cache.reduce((a, b) => a + b.memberCount, 0)} ${
      client.guilds.cache.reduce((a, b) => a + b.memberCount, 0) > 1 ? "Users," : "User,"
    }`,
  ];

  let i = 0;
  const interval = setInterval(() => {
    if (i >= messages.length) {
      clearInterval(interval);
      return;
    }
    setBotPresence(messages[i], client);
    i++;
  }, 10000);
};

// Helper function to render a progress bar
function renderProgress(filename, received, total) {
    const barWidth = 30;
    const percent = total ? received / total : 0;
    const filledBar = Math.floor(barWidth * percent);
    const emptyBar = barWidth - filledBar;
    const bar = '█'.repeat(filledBar) + '░'.repeat(emptyBar);
    const percentage = (percent * 100).toFixed(1);
    readline.clearLine(process.stdout, 0);
    readline.cursorTo(process.stdout, 0);
    process.stdout.write(`Downloading ${filename} [${bar}] ${percentage}% (${received}/${total} bytes)`);
}

// Download file from URL to destination with progress bar
async function downloadFile(url, dest) {
    await fs.mkdir(path.dirname(dest), { recursive: true });
    const file = await fs.open(dest, 'w');
    const stream = file.createWriteStream();
    const filename = path.basename(dest);

    return new Promise((resolve, reject) => {
        https.get(url, { headers: { 'User-Agent': 'Node.js' } }, (response) => {
            if (response.statusCode === 404) {
                reject(new Error(`Download skipped due to 404: ${url}`));
                return;
            }
            if (response.statusCode !== 200) {
                reject(new Error(`Failed to download ${url}: Status ${response.statusCode}`));
                return;
            }

            const totalBytes = parseInt(response.headers['content-length'], 10);
            let receivedBytes = 0;

            response.on('data', (chunk) => {
                receivedBytes += chunk.length;
                if (totalBytes) {
                    renderProgress(filename, receivedBytes, totalBytes);
                }
            });

            response.on('end', () => {
                process.stdout.write('\n'); // move to next line after done
            });

            pipelineAsync(response, stream)
                .then(resolve)
                .catch((error) => reject(new Error(`Download error for ${url}: ${error.message}`)));
        }).on('error', (error) => reject(new Error(`Download error for ${url}: ${error.message}`)));
    });
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function runCommand(cmd, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = require('child_process').spawn(cmd, args, options);
    let stdout = '';
    let stderr = '';

    if (child.stdout) child.stdout.on('data', (d) => (stdout += d));
    if (child.stderr) child.stderr.on('data', (d) => (stderr += d));

    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`Command failed (${code}): ${stderr || stdout}`));
    });
  });
}

async function setupPiper() {
  try {
    const platform = os.platform();

    // Define portable python path (adjust for your structure)
    const portablePythonDir = path.resolve(__dirname, 'python-portable');
    const pythonExe = platform === 'win32'
      ? path.join(portablePythonDir, 'python.exe')
      : path.join(portablePythonDir, 'bin', 'python3');

    // Check if portable python exists
    const hasPortablePython = await fileExists(pythonExe);

    if (!hasPortablePython) {
  logger.info('Portable Python not found, downloading and extracting...');

  if (platform === 'win32') {
    // Download official Python embeddable zip for Windows (adjust version/url if needed)
    const minicondaUrl = 'https://repo.anaconda.com/miniconda/Miniconda3-latest-Windows-x86_64.exe';
    const installerPath = path.join(__dirname, 'miniconda_installer.exe');

    await downloadFile(minicondaUrl, installerPath);

    // Run silent install to your portablePythonDir
    await runCommand(installerPath, ['/InstallationType=JustMe', '/AddToPath=0', `/RegisterPython=0`, `/S`, `/D=${portablePythonDir}`]);

    await fs.unlink(installerPath);

    logger.info('Extracted portable Python for Windows.');

  } else if (platform === 'linux' || platform === 'darwin') {
    // For Linux/macOS, you can download Miniconda installer and install silently to portablePythonDir
    // Example for Linux x86_64 Miniconda:
    const minicondaUrl = platform === 'linux'
      ? 'https://repo.anaconda.com/miniconda/Miniconda3-latest-Linux-x86_64.sh'
      : 'https://repo.anaconda.com/miniconda/Miniconda3-latest-MacOSX-x86_64.sh';

    const shPath = path.join(__dirname, 'miniconda.sh');
    await downloadFile(minicondaUrl, shPath);

    // Make installer executable and run silently
    await fs.chmod(shPath, 0o755);
    await runCommand('bash', [shPath, '-b', '-p', portablePythonDir]);
    await fs.unlink(shPath);

    logger.info('Installed Miniconda portable Python.');
  } else {
    throw new Error(`Unsupported platform: ${platform}`);
  }
}


    // Check if piper-tts installed
    let piperInstalled = false;
    try {
      await runCommand(pythonExe, ['-m', 'pip', 'install', '--upgrade', 'pip']);
      await runCommand(pythonExe, ['-m', 'pip', 'show', 'piper-tts']);
      piperInstalled = true;
    } catch {
      logger.info('piper-tts not installed in portable Python. Installing...');
      await runCommand(pythonExe, ['-m', 'pip', 'install', '--upgrade', 'pip']);
      await runCommand(pythonExe, ['-m', 'pip', 'install', 'piper-tts']);
      piperInstalled = true;
    }

    if (!piperInstalled) {
      throw new Error('Failed to install piper-tts');
    }
    logger.info('piper-tts is installed.');

    // Ensure models directory
    await fs.mkdir(MODELS_DIR, { recursive: true });

    // Download voice models if missing
    for (const model of VOICE_MODELS) {
      const onnxPath = path.join(MODELS_DIR, `${model.name}.onnx`);
      const jsonPath = path.join(MODELS_DIR, `${model.name}.onnx.json`);

      if (!(await fileExists(onnxPath))) {
        logger.info(`Downloading voice model ${model.name}.onnx...`);
        await downloadFile(model.onnx, onnxPath);
      }
      if (!(await fileExists(jsonPath))) {
        logger.info(`Downloading voice model metadata ${model.name}.onnx.json...`);
        await downloadFile(model.json, jsonPath);
      }
    }

    // Generate TTS config files for each voice model
    await fs.mkdir('tts_configs', { recursive: true });
    for (const model of VOICE_MODELS) {
      const configPath = path.join('tts_configs', `${model.name}.json`);
      const langCode = model.name.split('-')[0];
      const provider = langCode.toLowerCase() + '_' + model.name.split('-')[1].split('-')[0];
      const config = {
        provider: provider,
        voice: model.name,
        language: LANGUAGE_MAP[langCode] || 'Unknown Language',
        pythonPath: pythonExe,
        modelPath: path.join(MODELS_DIR, `${model.name}.onnx`),
        configPath: path.join(MODELS_DIR, `${model.name}.onnx.json`),
      };
      await fs.writeFile(configPath, JSON.stringify(config, null, 2));
      readline.clearLine(process.stdout, 0); readline.cursorTo(process.stdout, 0); process.stdout.write(`Generated TTS config: ${model.name}.json\r`);
    }

    logger.info('Piper Python setup complete.');
  } catch (error) {
    readline.clearLine(process.stdout, 0);
    readline.cursorTo(process.stdout, 0);
    process.stdout.write(`Error setting up Piper TTS: ${error.message}\r`);
    process.exit(1);
  }
}

// Bot class to handle each instance
class TtsBot {
    constructor(config) {
        this.config = config;
        this.client = new Client({
          intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMembers, 
            GatewayIntentBits.GuildModeration,
            GatewayIntentBits.GuildEmojisAndStickers,
            GatewayIntentBits.GuildIntegrations,
            GatewayIntentBits.GuildWebhooks,
            GatewayIntentBits.GuildInvites,
            GatewayIntentBits.GuildPresences,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.GuildMessageReactions,
            GatewayIntentBits.GuildMessageTyping,
            GatewayIntentBits.DirectMessages,
            GatewayIntentBits.DirectMessageReactions,
            GatewayIntentBits.DirectMessageTyping,
            GatewayIntentBits.MessageContent,
            GatewayIntentBits.GuildScheduledEvents, 
            GatewayIntentBits.GuildVoiceStates,
          ], 
          partials: [
            Partials.User,
            Partials.Channel,
            Partials.GuildMember,
            Partials.Message,
            Partials.Reaction,
            Partials.GuildScheduledEvent,
            Partials.ThreadMember
          ]
        });
        this.setupClient();
    }

    async setupClient() {
        const { registerCommands, saveTtsQueue, ensureServerQueue, loadTtsQueue } = require('./bot.js');
        await registerCommands(this.client, this.config);
        this.client.on('ready', async () => {
            logger.info(`Bot ${this.config.botName} logged in as ${this.client.user.tag}`);
            await loadTtsQueue();
            for (const guild of this.client.guilds.cache.values()) {
              ensureServerQueue(guild.id);
            }
            await saveTtsQueue();

            // Fetch and set initial bot presence
            rotatePresenceMessages(this.client);
            setInterval(rotatePresenceMessages(this.client), 90000);
        });
        
        this.client.on('guildCreate', async (guild) => {
          await loadTtsQueue();
          ensureServerQueue(guild.id);
          await saveTtsQueue();
        });

        this.client.on('guildDelete', async (guild) => {
          await loadTtsQueue();
          delete ttsQueue[guild.id];
          delete isPlaying[guild.id];
          await saveTtsQueue();
        });
        this.client.login(this.config.token).catch((error) => {
            logger.error(`Bot ${this.config.botName} login failed: ${error.message}`);
        });
    }
}

// Load bot configurations and start bots
async function startBots() {
    try {
        await setupPiper();
        await fs.mkdir(BOT_CONFIG_DIR, { recursive: true });
        const files = await fs.readdir(BOT_CONFIG_DIR);
        for (const file of files) {
            // Skip example.json
            if (file === 'example.json') continue;
            
            if (file.endsWith('.json')) {
                const configPath = path.join(BOT_CONFIG_DIR, file);
                const configData = await fs.readFile(configPath, 'utf-8');
                try {
                    const config = JSON.parse(configData);
                    if (!config.token || !config.botName) {
                        logger.error(`Invalid config in ${file}: Missing token or botName`);
                        continue;
                    }
                    const bot = new TtsBot(config);
                    bots.push(bot);
                    logger.info(`Started bot instance: ${config.botName}`);
                } catch (error) {
                    logger.error(`Error parsing config ${file}: ${error.message}`);
                }
            }
        }
        if (bots.length === 0) {
            logger.error('No valid bot configurations found.');
            process.exit(1);
        }
    } catch (error) {
        logger.error(`Error loading bot configs: ${error.message}`);
        process.exit(1);
    }
}

// Start all bots
startBots();

// ———————————————[Error Handling]———————————————
process.on("unhandledRejection", (reason, p) => {

   if (reason === "Error [INTERACTION_ALREADY_REPLIED]: The reply to this interaction has already been sent or deferred.") return;

   console.log(chalk.gray("—————————————————————————————————"));
   console.log(
      chalk.white("["),
      chalk.red.bold("AntiCrash"),
      chalk.white("]"),
      chalk.gray(" : "),
      chalk.white.bold("Unhandled Rejection/Catch")
   );
   console.log(chalk.gray("—————————————————————————————————"));
   console.log(reason, p);
});
process.on("uncaughtException", (err, origin) => {
   console.log(chalk.gray("—————————————————————————————————"));
   console.log(
      chalk.white("["),
      chalk.red.bold("AntiCrash"),
      chalk.white("]"),
      chalk.gray(" : "),
      chalk.white.bold("Uncaught Exception/Catch")
   );
   console.log(chalk.gray("—————————————————————————————————"));
   console.log(err, origin);
});

/*process.on("multipleResolves", (type, promise, reason) => {

   if (reason === "Error: Cannot perform IP discovery - socket closed") return;
   if (reason === "AbortError: The operation was aborted") return;

   console.log(chalk.gray("—————————————————————————————————"));
   console.log(
      chalk.white("["),
      chalk.red.bold("AntiCrash"),
      chalk.white("]"),
      chalk.gray(" : "),
      chalk.white.bold("Multiple Resolves")
   );
   console.log(chalk.gray("—————————————————————————————————"));
   console.log(type, promise, reason);
});*/