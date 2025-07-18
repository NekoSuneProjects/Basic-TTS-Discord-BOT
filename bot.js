const {
  SlashCommandBuilder,
  PermissionFlagsBits
} = require("discord.js");
const {
  joinVoiceChannel,
  getVoiceConnection,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus
} = require("@discordjs/voice");
const fs = require("fs").promises; // Fixed: Use .promises instead of .promisify
const path = require("path");
const { spawn } = require("child_process");
const readline = require("readline");
const logger = console;

// TTS configuration directory and user preferences file
const CONFIG_DIR = "tts_configs";
const USER_PREFS_FILE = "user_prefs.json";

const TTS_QUEUE_FILE = "tts_queue.json";

// Lock to prevent race conditions
let isPlaying = false;
let ttsQueue = [];

// Load the TTS queue from disk if available
async function loadTtsQueue() {
  try {
    const data = await fs.readFile(TTS_QUEUE_FILE, 'utf8');
    ttsQueue = JSON.parse(data);
  } catch (err) {
    ttsQueue = [];
  }
}

// Save the current TTS queue to disk
async function saveTtsQueue() {
  await fs.writeFile(TTS_QUEUE_FILE, JSON.stringify(ttsQueue, null, 2));
}
// Enqueue new TTS audio
async function enqueueTtsAudio(audioPath, connection, interaction, logger, provider) {
  await loadTtsQueue(); // always refresh latest from disk

  ttsQueue.push({ audioPath, provider });
  await saveTtsQueue(); // Persist immediately

  if (!isPlaying) {
    playNext(connection, interaction, logger);
  }
}
// Enqueue audio and start playing if idle
async function enqueueTtsAudio(audioPath, connection, interaction, logger, provider) {
  await loadTtsQueue(); // always refresh latest from disk

  ttsQueue.push({ audioPath, provider });
  await saveTtsQueue();

  if (!isPlaying) {
    playNext(connection, interaction, logger);
  }
}

// Play the next item in the queue
async function playNext(connection, interaction, logger) {
  await loadTtsQueue(); // always refresh latest from disk

  if (ttsQueue.length === 0) {
    isPlaying = false;
    return;
  }

  isPlaying = true;
  const { audioPath, provider } = ttsQueue[0]; // don't pop yet

  if (!audioPath || !connection) {
    ttsQueue.shift();
    await saveTtsQueue();
    return playNext(connection, interaction, logger);
  }

  const player = createAudioPlayer();
  const resource = createAudioResource(audioPath);
  connection.subscribe(player);
  player.play(resource);

  player.once(AudioPlayerStatus.Idle, async () => {
    await fs.unlink(audioPath).catch(() => {});
    ttsQueue.shift();
    await saveTtsQueue();
    playNext(connection, interaction, logger);
  });

  player.on("error", async error => {
    logger.error(`Audio player error: ${error.message}`);
    interaction.followUp("Failed to play TTS audio.").catch(() => {});
    ttsQueue.shift();
    await saveTtsQueue();
    playNext(connection, interaction, logger);
  });

  await interaction.followUp(`🔊 Playing TTS using ${provider}.`).catch(() => {});
}

// Store TTS configurations and user preferences
const ttsConfigs = {};
let userPrefs = {};

// Load TTS configurations
async function loadTtsConfigs() {
  try {
    await fs.mkdir(CONFIG_DIR, { recursive: true });
    await fs.mkdir('audios', { recursive: true });
    const files = await fs.readdir(CONFIG_DIR);
    for (const file of files) {
      if (file.endsWith(".json")) {
        const providerName = file.slice(0, -5);
        const configPath = path.join(CONFIG_DIR, file);
        const configData = await fs.readFile(configPath, "utf-8");
        try {
          ttsConfigs[providerName] = JSON.parse(configData);
          readline.clearLine(process.stdout, 0);
          readline.cursorTo(process.stdout, 0);
          process.stdout.write(`Loaded TTS config: ${providerName}\r`);
        } catch (error) {
          readline.clearLine(process.stdout, 0);
          readline.cursorTo(process.stdout, 0);
          process.stdout.write(
            `Error parsing TTS config ${file}: ${error.message}\r`
          );
        }
      }
    }
  } catch (error) {
    logger.error(`Error loading TTS configs: ${error.message}`);
  }
}


// Load user preferences
async function loadUserPrefs() {
  try {
    await fs.access(USER_PREFS_FILE);
    const data = await fs.readFile(USER_PREFS_FILE, "utf-8");
    userPrefs = JSON.parse(data);
    logger.info("Loaded user preferences");
  } catch (error) {
    if (error.code === "ENOENT") {
      userPrefs = {};
      await saveUserPrefs();
      logger.info("Created empty user preferences file");
    } else {
      logger.error(`Error loading user preferences: ${error.message}`);
    }
  }
}

// Save user preferences
async function saveUserPrefs() {
  try {
    await fs.writeFile(USER_PREFS_FILE, JSON.stringify(userPrefs, null, 2));
    logger.info("Saved user preferences");
  } catch (error) {
    logger.error(`Error saving user preferences: ${error.message}`);
  }
}

// Generate TTS audio using piper-tts
async function generateTts(
  text,
  provider,
  outputFile = `audios/output_${Date.now()}.wav`
) {
  const config = ttsConfigs[provider];
  if (!config) {
    logger.error(`No TTS config found for provider: ${provider}`);
    return null;
  }

  const voice = config.voice || "en_US-lessac-medium";
  const modelPath = path.resolve(
    config.modelPath || `./piper/models/${voice}.onnx`
  );

  return new Promise((resolve, reject) => {
    const args = [
      "-m",
      "piper",
      "--model",
      modelPath,
      "--output_file",
      outputFile
    ];
    const child = spawn(config.pythonPath, args, {
      stdio: ["pipe", "inherit", "inherit"]
    });

    child.stdin.write(text + "\n");
    child.stdin.end();

    child.on("close", code => {
      if (code === 0) resolve(outputFile);
      else reject(new Error(`Piper exited with code ${code}`));
    });

    child.on("error", reject);
  });
}

// Define slash commands
function getSlashCommands() {
  return [
    new SlashCommandBuilder()
      .setName("join")
      .setDescription("Join the user’s voice channel")
      .setDefaultMemberPermissions(PermissionFlagsBits.Connect),
    new SlashCommandBuilder()
      .setName("leave")
      .setDescription("Leave the voice channel")
      .setDefaultMemberPermissions(PermissionFlagsBits.Connect),
    new SlashCommandBuilder()
      .setName("tts")
      .setDescription("Convert text to speech and play in voice channel")
      .addStringOption(option =>
        option
          .setName("message")
          .setDescription("Text to convert to speech")
          .setRequired(true)
      )
      .addStringOption(option =>
        option
          .setName("provider")
          .setDescription(
            "TTS provider to use (optional, uses your preference if not set)"
          )
          .setRequired(false)
      )
      .setDefaultMemberPermissions(PermissionFlagsBits.Connect),
    new SlashCommandBuilder()
      .setName("settts")
      .setDescription("Set your preferred TTS provider")
      .addStringOption(option =>
        option
          .setName("provider")
          .setDescription("TTS provider to set as preference")
          .setRequired(true)
      )
      .setDefaultMemberPermissions(PermissionFlagsBits.Connect),
    new SlashCommandBuilder()
      .setName("providers")
      .setDescription("List available TTS providers")
      .setDefaultMemberPermissions(PermissionFlagsBits.Connect),
    new SlashCommandBuilder()
      .setName("reload")
      .setDescription("Reload slash commands (admin only)")
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  ];
}

// Register slash commands for all guilds
async function registerGuildCommands(client, botConfig) {
  try {
    await loadTtsConfigs(); // Reload TTS configs to reflect new providers
    const commands = getSlashCommands();
    for (const guild of client.guilds.cache.values()) {
      await guild.commands.set(commands);
      logger.info(
        `Registered slash commands for ${botConfig.botName} in guild ${guild.name} (${guild.id})`
      );
    }
  } catch (error) {
    logger.error(
      `Error registering guild commands for ${botConfig.botName}: ${error.message}`
    );
  }
}

const voiceConnections = new Map(); // key: guildId, value: VoiceConnection

// Register slash commands and set up interaction handler
async function registerCommands(client, botConfig) {
  await loadUserPrefs(); // Load user preferences once at startup

  // Register commands when the client is ready
  client.on("ready", async () => {
    await registerGuildCommands(client, botConfig);
    logger.info(`Bot ${botConfig.botName} is ready and commands registered`);
  });

  // Handle interactions
  client.on("interactionCreate", async interaction => {
    const { commandName, guildId, user } = interaction;
    if (!interaction.isCommand()) return;

    if (commandName === "join") {
      if (interaction.member.voice.channel) {
        const channel = interaction.member.voice.channel;
        const connection = joinVoiceChannel({
          channelId: channel.id,
          guildId: channel.guild.id,
          adapterCreator: channel.guild.voiceAdapterCreator
        });

        voiceConnections.set(channel.guild.id, connection);
        await interaction.reply(`Joined ${channel.name}`);
      } else {
        await interaction.reply("You are not in a voice channel!");
      }
    }

    if (commandName === "leave") {
      const connection = client.voice.adapters.get(guildId);
      if (connection) {
        connection.destroy();
        await interaction.reply("Left the voice channel.");
      } else {
        await interaction.reply("Not in a voice channel!");
      }
    }

    if (commandName === "tts") {
      let provider = interaction.options.getString("provider");
      const text = interaction.options.getString("message");

      // Get user preference or fall back to bot's default provider
      const userId = user.id;
      if (!provider) {
        provider =
          userPrefs[`${guildId}:${userId}`] ||
          botConfig.defaultProvider ||
          "en_us_lessac";
      }

      if (!ttsConfigs[provider]) {
        await interaction.reply(
          `Unknown provider: ${provider}. Available: ${Object.keys(
            ttsConfigs
          ).join(", ")}`
        );
        return;
      }

      const connection = getVoiceConnection(guildId);
      if (!connection) {
        await interaction.reply("I’m not in a voice channel! Use /join first.");
        return;
      }

      await interaction.deferReply();
      const outputFile = `audios/output_${provider}_${Date.now()}.wav`;
      const audioFile = await generateTts(text, provider, outputFile);

      await enqueueTtsAudio(audioFile, connection, interaction, logger, provider);
    }

    if (commandName === "settts") {
      const input = interaction.options.getString("provider");
      const providerKey = Object.keys(ttsConfigs).find(
        key => key.toLowerCase() === input
      );

      if (!providerKey) {
        await interaction.reply({
          content: `❌ Unknown provider: **${input}**\nAvailable: ${Object.keys(
            ttsConfigs
          ).join(", ")}`,
          ephemeral: true
        });
        return;
      }

      const userId = user.id;
      userPrefs[`${guildId}:${userId}`] = providerKey;
      await saveUserPrefs();
      await interaction.reply(`✅ Set your TTS provider to **${providerKey}**.`);
    }

    if (commandName === "providers") {
      if (Object.keys(ttsConfigs).length > 0) {
        const providerList = Object.entries(ttsConfigs)
          .map(([name, config]) => `${name} (${config.language})`)
          .join(", ");
        await interaction.reply(`Available TTS providers: ${providerList}`);
      } else {
        await interaction.reply("No TTS providers configured.");
      }
    }

    if (commandName === "reload") {
      if (
        !interaction.member.permissions.has(PermissionFlagsBits.Administrator)
      ) {
        await interaction.reply(
          "You need Administrator permissions to use this command."
        );
        return;
      }

      try {
        await registerGuildCommands(client, botConfig);
        await interaction.reply("Slash commands reloaded successfully.");
      } catch (error) {
        logger.error(`Error reloading commands: ${error.message}`);
        await interaction.reply("Failed to reload slash commands.");
      }
    }
  });
}

module.exports = { registerCommands };
