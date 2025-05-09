// Takkard Discord Bot
// This file sets up the Discord bot and Express server to handle frontend requests

const express = require('express');
const multer = require('multer');
const { Client, GatewayIntentBits, Partials, AttachmentBuilder } = require('discord.js');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

console.log("TOKEN Length:", (process.env.BOT_TOKEN || '').length);
console.log("TOKEN Exists:", !!process.env.BOT_TOKEN);

// Initialize Discord client
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel]
});

// Express setup
const app = express();
const PORT = process.env.PORT || 3000;

// Set up storage for file uploads
const storage = multer.diskStorage({
  destination: function(req, file, cb) {
    const uploadDir = path.join(__dirname, 'uploads');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: function(req, file, cb) {
    cb(null, Date.now() + '-' + file.originalname);
  }
});

const upload = multer({ 
  storage: storage,
  limits: { fileSize: 8 * 1024 * 1024 } // 8MB limit
});

// Serve static frontend files
app.use(express.static(path.join(__dirname, 'public')));

// Map of channel names to Discord channel IDs (replace these with your actual channel IDs)
const channelMap = {
  'general': process.env.CHANNEL_DEBUG
};

// Cache to store recent messages for each channel
const messageCache = {};

// Initialize message cache for each channel
Object.keys(channelMap).forEach(channel => {
  messageCache[channel] = [];
});

// API endpoint to send messages to Discord
app.post('/api/send-discord-message', upload.single('file'), async (req, res) => {
  try {
    const { username, message, channel } = req.body;
    
    if (!channelMap[channel]) {
      return res.status(400).json({ success: false, error: 'Invalid channel' });
    }

    const discordChannel = await client.channels.fetch(channelMap[channel]);
    if (!discordChannel) {
      return res.status(404).json({ success: false, error: 'Discord channel not found' });
    }

    // Format the message content
    const formattedMessage = `**${username}**: ${message}`;

    // If there's a file, attach it to the message
    if (req.file) {
      const attachment = new AttachmentBuilder(req.file.path);
      await discordChannel.send({ content: formattedMessage, files: [attachment] });
      
      // Add to cache
      messageCache[channel].push({
        username,
        content: message,
        imageUrl: `/uploads/${path.basename(req.file.path)}`
      });
    } else {
      await discordChannel.send({ content: formattedMessage });
      
      // Add to cache
      messageCache[channel].push({
        username,
        content: message
      });
    }

    // Limit cache to 10 messages per channel
    if (messageCache[channel].length > 10) {
      messageCache[channel] = messageCache[channel].slice(-10);
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Error sending message to Discord:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// API endpoint to get messages from a specific channel
app.get('/api/get-discord-messages', async (req, res) => {
  try {
    const { channel } = req.query;
    
    if (!channelMap[channel]) {
      return res.status(400).json({ success: false, error: 'Invalid channel' });
    }

    // Return messages from cache
    res.json({ success: true, messages: messageCache[channel] });
    
  } catch (error) {
    console.error('Error getting Discord messages:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// API endpoint to get available channels from the Discord server
app.get('/api/get-discord-channels', async (req, res) => {
  try {
    // Get the Discord guild (server) ID from the first channel
    const anyChannelId = Object.values(channelMap)[0];
    if (!anyChannelId) {
      return res.status(404).json({ success: false, error: 'No channels configured' });
    }
    
    const anyChannel = await client.channels.fetch(anyChannelId);
    if (!anyChannel || !anyChannel.guild) {
      return res.status(404).json({ success: false, error: 'Could not fetch Discord server' });
    }
    
    const guild = anyChannel.guild;
    
    // Get all text channels from the guild
    const textChannels = guild.channels.cache
      .filter(c => c.type === 0) // 0 is GUILD_TEXT
      .map(channel => ({
        id: channel.id,
        name: channel.name,
        configured: Object.values(channelMap).includes(channel.id)
      }));
    
    // Get the configured channels with their proper names
    const configuredChannels = Object.entries(channelMap).map(([configName, channelId]) => {
      const channel = guild.channels.cache.get(channelId);
      return {
        configName,
        id: channelId,
        name: channel ? channel.name : configName,
        exists: !!channel
      };
    });
    
    res.json({ 
      success: true, 
      channels: {
        all: textChannels,
        configured: configuredChannels
      }
    });
    
  } catch (error) {
    console.error('Error getting Discord channels:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/index.html'));
});

app.listen(PORT, () => {
  console.log(`Frontend running on port ${PORT}`);
});

// Handle Discord bot events
client.once('ready', () => {
  console.log(`Bot is online! Logged in as ${client.user.tag}`);
  
  // Initialize message cache with recent messages
  fetchRecentMessages();
});

// Function to fetch recent messages for all channels
async function fetchRecentMessages() {
  try {
    for (const [channelName, channelId] of Object.entries(channelMap)) {
      const channel = await client.channels.fetch(channelId);
      const messages = await channel.messages.fetch({ limit: 10 });
      
      const cachedMessages = [];
      
      messages.reverse().forEach(msg => {
        // Parse username from the message format "**USERNAME**: MESSAGE"
        const content = msg.content;
        let username = 'Unknown';
        let messageContent = content;
        
        const match = content.match(/^\*\*(.*?)\*\*: (.*)$/);
        if (match) {
          username = match[1];
          messageContent = match[2];
        }
        
        const messageData = {
          username,
          content: messageContent
        };
        
        // Add image URL if present
        if (msg.attachments.size > 0) {
          messageData.imageUrl = msg.attachments.first().url;
        }
        
        cachedMessages.push(messageData);
      });
      
      messageCache[channelName] = cachedMessages;
    }
    console.log('Message cache initialized with recent messages');
  } catch (error) {
    console.error('Error fetching recent messages:', error);
  }
}

// Handle new messages from Discord to update the cache
client.on('messageCreate', async (message) => {
  try {
    // Ignore bot's own messages
    if (message.author.id === client.user.id) return;
    
    // Find which channel this message belongs to
    const channelEntry = Object.entries(channelMap).find(([_, id]) => id === message.channel.id);
    if (!channelEntry) return;
    
    const [channelName] = channelEntry;
    
    // Parse username from the message format "**USERNAME**: MESSAGE" if it exists
    const content = message.content;
    let username = message.author.username;
    let messageContent = content;
    
    const match = content.match(/^\*\*(.*?)\*\*: (.*)$/);
    if (match) {
      username = match[1];
      messageContent = match[2];
    }
    
    const messageData = {
      username,
      content: messageContent
    };
    
    // Add image URL if present
    if (message.attachments.size > 0) {
      messageData.imageUrl = message.attachments.first().url;
    }
    
    // Add to cache
    messageCache[channelName].push(messageData);
    
    // Limit cache to 10 messages
    if (messageCache[channelName].length > 10) {
      messageCache[channelName] = messageCache[channelName].slice(-10);
    }
  } catch (error) {
    console.error('Error handling new message:', error);
  }
});

// Start Express server after Discord bot is ready
client.login(process.env.BOT_TOKEN)
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });
  })
  .catch(error => {
    console.error('Error logging in to Discord:', error);
    process.exit(1);
  });