import { Message, EmbedBuilder } from 'discord.js';

export interface ParsedRestockMessage {
  productName: string;
  retailer: string;
  price?: string;
  type?: string;
  stock?: string;
  tcin?: string;
  rawTitle: string;
}

// Known restock bot identifiers
const RESTOCK_BOT_NAMES = [
  'target restocks',
  'walmart restocks',
  'best buy restocks',
  'amazon restocks',
  'gamestop restocks',
  'zephyr monitors',
  'restock alerts'
];

export function isRestockBot(authorName: string): boolean {
  const lowerName = authorName.toLowerCase();
  return RESTOCK_BOT_NAMES.some(bot => lowerName.includes(bot));
}

// Words that should skip the search
const SKIP_WORDS = ['queue'];

export function shouldSkipSearch(text: string): boolean {
  const lowerText = text.toLowerCase();
  return SKIP_WORDS.some(word => lowerText.includes(word));
}


export function isPokemonProduct(text: string): boolean {
  const pokemonKeywords = [
    'pok├⌐mon',
    'pokemon',
    'pikachu',
    'charizard',
    'booster',
    'elite trainer box',
    'etb',
    'tcg',
    'trading card',
    'scarlet',
    'violet',
    'paldea',
    'obsidian flames',
    'paradox rift',
    'temporal forces',
    'twilight masquerade',
    'shrouded fable',
    'stellar crown',
    'surging sparks',
    'prismatic evolutions',
    'destined rivals'
  ];

  const lowerText = text.toLowerCase();
  return pokemonKeywords.some(keyword => lowerText.includes(keyword));
}

export function parseRestockEmbed(message: Message): ParsedRestockMessage | null {
  // Check if message has embeds
  if (!message.embeds || message.embeds.length === 0) {
    return null;
  }

  const embed = message.embeds[0];

  // Try to get product name from embed title or description
  let productName = embed.title || '';

  if (!productName && embed.description) {
    // Sometimes the product name is in the first line of description
    productName = embed.description.split('\n')[0];
  }

  if (!productName) {
    return null;
  }

  // Check if it's a Pokemon product
  if (!isPokemonProduct(productName)) {
    return null;
  }

  // Parse retailer from author or footer
  let retailer = 'Unknown';
  if (embed.author?.name) {
    retailer = embed.author.name;
  } else if (embed.footer?.text) {
    retailer = embed.footer.text.split('|')[0].trim();
  } else if (message.author.username) {
    retailer = message.author.username;
  }

  // Parse fields for additional info
  let price: string | undefined;
  let type: string | undefined;
  let stock: string | undefined;
  let tcin: string | undefined;

  if (embed.fields) {
    for (const field of embed.fields) {
      const fieldName = field.name.toLowerCase();
      const fieldValue = field.value;

      if (fieldName === 'price') {
        price = fieldValue;
      } else if (fieldName === 'type') {
        type = fieldValue;
      } else if (fieldName === 'total stock' || fieldName === 'stock') {
        stock = fieldValue;
      } else if (fieldName === 'tcin') {
        tcin = fieldValue;
      }
    }
  }

  return {
    productName,
    retailer,
    price,
    type,
    stock,
    tcin,
    rawTitle: productName
  };
}

// Common abbreviation expansions
const ABBREVIATIONS: Record<string, string> = {
  'upc': 'Ultra Premium Collection',
  'etb': 'Elite Trainer Box',
  'bb': 'Booster Box'
};

export function cleanProductName(name: string): string {
  let cleaned = name
    .replace(/^Pokémon Trading Card Game:\s*/i, '')
    .replace(/^Pokemon Trading Card Game:\s*/i, '')
    .replace(/^Pokemon TCG:\s*/i, '')
    .replace(/^PTCG:\s*/i, '')
    .replace(/—/g, '-')
    .replace(/\s+/g, ' ')
    .trim();

  // Expand abbreviations (case-insensitive, whole word only)
  for (const [abbrev, full] of Object.entries(ABBREVIATIONS)) {
    const regex = new RegExp(`\\b${abbrev}\\b`, 'gi');
    cleaned = cleaned.replace(regex, full);
  }

  return cleaned;
}

