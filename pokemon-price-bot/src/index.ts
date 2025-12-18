import { Client, GatewayIntentBits, Message, EmbedBuilder, Partials } from 'discord.js';
import { config } from 'dotenv';
import { tcgplayerService, ProductWithPrice } from './services/tcgplayerService.js';
import { isPokemonProduct, cleanProductName, shouldSkipSearch } from './services/messageParser.js';

config();

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const MONITORED_CHANNEL_IDS = process.env.MONITORED_CHANNEL_IDS?.split(',').map(id => id.trim()) || [];
const COMMAND_PREFIX = process.env.COMMAND_PREFIX || '!price';
const AUTO_RESPOND = process.env.AUTO_RESPOND !== 'false'; // Default to true

if (!DISCORD_TOKEN) {
  console.error('ERROR: DISCORD_TOKEN is required in .env file');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages
  ],
  partials: [Partials.Channel, Partials.Message]
});

function createPriceEmbed(product: ProductWithPrice, retailPrice?: string): EmbedBuilder {
  const prices = product.prices;
  const mainPrice = prices.find(p => p.subTypeName === 'Normal') || prices[0];

  const embed = new EmbedBuilder()
    .setColor(0xFFCB05) // Pokemon yellow
    .setTitle(`${product.name}`)
    .setURL(tcgplayerService.getProductUrl(product));

  if (product.imageUrl) {
    embed.setThumbnail(product.imageUrl);
  }

  // Add TCGplayer prices
  const priceFields: string[] = [];
  if (mainPrice) {
    if (mainPrice.marketPrice !== null) {
      priceFields.push(`**Market:** $${mainPrice.marketPrice.toFixed(2)}`);
    }
    if (mainPrice.lowPrice !== null) {
      priceFields.push(`**Low:** $${mainPrice.lowPrice.toFixed(2)}`);
    }
    if (mainPrice.midPrice !== null) {
      priceFields.push(`**Mid:** $${mainPrice.midPrice.toFixed(2)}`);
    }
    if (mainPrice.highPrice !== null) {
      priceFields.push(`**High:** $${mainPrice.highPrice.toFixed(2)}`);
    }
  }

  if (priceFields.length > 0) {
    embed.addFields({
      name: 'TCGplayer Prices',
      value: priceFields.join('\n'),
      inline: true
    });
  }

  // Show retail price comparison if available
  if (retailPrice && retailPrice !== 'N/A') {
    embed.addFields({
      name: 'Retail Price',
      value: retailPrice,
      inline: true
    });

    // Calculate potential savings/markup
    if (mainPrice?.marketPrice && retailPrice.includes('$')) {
      const retailNum = parseFloat(retailPrice.replace(/[^0-9.]/g, ''));
      if (!isNaN(retailNum)) {
        const diff = mainPrice.marketPrice - retailNum;
        const percentDiff = ((diff / retailNum) * 100).toFixed(1);
        const indicator = diff > 0 ? '≡ƒôê' : diff < 0 ? '≡ƒôë' : 'Γ₧û';
        embed.addFields({
          name: 'Value Comparison',
          value: `${indicator} Market is ${diff > 0 ? '+' : ''}$${diff.toFixed(2)} (${diff > 0 ? '+' : ''}${percentDiff}%) vs retail`,
          inline: false
        });
      }
    }
  }

  embed.addFields({
    name: 'Set',
    value: product.groupName || 'Unknown',
    inline: true
  });

  embed.setFooter({ text: 'Data from TCGplayer via tcgcsv.com' });
  embed.setTimestamp();

  return embed;
}

function createSearchResultsEmbed(query: string, results: ProductWithPrice[]): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(0xFFCB05)
    .setTitle(`Search Results: "${query}"`)
    .setDescription(results.length === 0
      ? 'No matching products found.'
      : `Found ${results.length} matching product(s):`);

  for (let i = 0; i < Math.min(results.length, 5); i++) {
    const product = results[i];
    const prices = product.prices;
    const mainPrice = prices.find(p => p.subTypeName === 'Normal') || prices[0];

    let priceText = 'No price data';
    if (mainPrice?.marketPrice !== null) {
      priceText = `Market: $${mainPrice.marketPrice.toFixed(2)}`;
    }

    embed.addFields({
      name: `${i + 1}. ${product.name}`,
      value: `${priceText}\n[View on TCGplayer](${tcgplayerService.getProductUrl(product)})`,
      inline: false
    });
  }

  embed.setFooter({ text: 'Data from TCGplayer via tcgcsv.com' });
  embed.setTimestamp();

  return embed;
}

function extractProductNames(message: Message): { name: string; retailPrice?: string }[] {
  const products: { name: string; retailPrice?: string }[] = [];

  // Extract from embeds
  for (const embed of message.embeds) {
    if (embed.title && isPokemonProduct(embed.title)) {
      const priceField = embed.fields?.find(f => f.name.toLowerCase() === 'price');
      products.push({
        name: embed.title,
        retailPrice: priceField?.value
      });
    }
    if (embed.description) {
      const lines = embed.description.split('\n');
      for (const line of lines) {
        if (isPokemonProduct(line) && line.length > 10) {
          products.push({ name: line.trim() });
        }
      }
    }
  }

  // Extract from message content (plain text)
  if (message.content && isPokemonProduct(message.content)) {
    // Try to extract product name from the text
    // Look for common patterns or just use the whole content
    const content = message.content.trim();

    // Split by newlines and check each line
    const lines = content.split('\n');
    for (const line of lines) {
      const trimmedLine = line.trim();
      if (trimmedLine.length > 10 && isPokemonProduct(trimmedLine)) {
        products.push({ name: trimmedLine });
      }
    }

    // If no lines matched but content has Pokemon keywords, use full content
    if (products.length === 0 && content.length > 10) {
      products.push({ name: content });
    }
  }

  return products;
}

async function handleChannelMessage(message: Message): Promise<void> {
  const fullText = message.content + ' ' + message.embeds.map(e => e.title || '').join(' ');
  
    if (shouldSkipSearch(fullText)) {
      console.log('Skipping message containing skip word');
      return;
    }

  const productInfos = extractProductNames(message);

  if (productInfos.length === 0) {
    return;
  }

  console.log(`Found ${productInfos.length} Pokemon product(s) in message`);

  for (const productInfo of productInfos) {
    const cleanedName = cleanProductName(productInfo.name);
    console.log(`Searching for: ${cleanedName}`);

    const results = tcgplayerService.searchProducts(cleanedName, 1);

    if (results.length === 0) {
      console.log(`No TCGplayer match found for: ${cleanedName}`);
      continue;
    }

    const product = results[0];
    const embed = createPriceEmbed(product, productInfo.retailPrice);

    try {
      await message.reply({ embeds: [embed] });
      console.log(`Replied with price for: ${product.name}`);
    } catch (error) {
      console.error('Error replying to message:', error);
    }
  }
}

async function handlePriceCommand(message: Message, query: string): Promise<void> {
  if (!query.trim()) {
    await message.reply('Please provide a product name to search. Example: `!price Scarlet Violet Booster Box`');
    return;
  }

  console.log(`Price search requested: ${query}`);

  const results = tcgplayerService.searchProducts(query, 5);

  if (results.length === 0) {
    await message.reply(`No products found matching "${query}". Try a different search term.`);
    return;
  }

  // If there's a strong single match, show detailed price info
  if (results.length === 1 || results[0].name.toLowerCase().includes(query.toLowerCase())) {
    const embed = createPriceEmbed(results[0]);
    await message.reply({ embeds: [embed] });
  } else {
    // Show multiple results
    const embed = createSearchResultsEmbed(query, results);
    await message.reply({ embeds: [embed] });
  }
}

client.once('ready', async () => {
  console.log(`Logged in as ${client.user?.tag}`);
  console.log(`Monitoring ${MONITORED_CHANNEL_IDS.length} channel(s) for restocks`);
  console.log(`Auto-respond mode: ${AUTO_RESPOND ? 'ON' : 'OFF'}`);
  console.log(`Command prefix: ${COMMAND_PREFIX}`);

  // Initialize TCGplayer data
  console.log('Loading TCGplayer product data...');
  try {
    await tcgplayerService.initialize();
    console.log('TCGplayer data loaded successfully!');
  } catch (error) {
    console.error('Error loading TCGplayer data:', error);
  }
});

client.on('messageCreate', async (message: Message) => {
  // Ignore own messages
  if (message.author.id === client.user?.id) {
    return;
  }

  // Handle price command
  if (message.content.startsWith(COMMAND_PREFIX)) {
    const query = message.content.slice(COMMAND_PREFIX.length).trim();
    await handlePriceCommand(message, query);
    return;
  }

  // Auto-respond to messages in monitored channels
  if (AUTO_RESPOND && MONITORED_CHANNEL_IDS.length > 0) {
    // Only respond in specified channels
    if (MONITORED_CHANNEL_IDS.includes(message.channelId)) {
      await handleChannelMessage(message);
    }
  }
});

// Handle errors gracefully
client.on('error', (error) => {
  console.error('Discord client error:', error);
});

process.on('unhandledRejection', (error) => {
  console.error('Unhandled promise rejection:', error);
});

// Start the bot
console.log('Starting Pokemon Price Bot...');
client.login(DISCORD_TOKEN);
