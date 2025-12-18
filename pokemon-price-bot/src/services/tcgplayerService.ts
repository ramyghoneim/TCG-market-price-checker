import Fuse from 'fuse.js';

const TCGCSV_BASE_URL = 'https://tcgcsv.com';
const POKEMON_CATEGORY_ID = 3;

export interface TCGGroup {
  groupId: number;
  name: string;
  abbreviation: string;
  publishedOn: string;
  modifiedOn: string;
  categoryId: number;
}

export interface TCGProduct {
  productId: number;
  name: string;
  cleanName: string;
  imageUrl: string;
  categoryId: number;
  groupId: number;
  url: string;
  modifiedOn: string;
  extendedData?: Array<{ name: string; value: string }>;
}

export interface TCGPrice {
  productId: number;
  lowPrice: number | null;
  midPrice: number | null;
  highPrice: number | null;
  marketPrice: number | null;
  directLowPrice: number | null;
  subTypeName: string;
}

export interface ProductWithPrice extends TCGProduct {
  prices: TCGPrice[];
  groupName: string;
}

class TCGPlayerService {
  private groupsCache: TCGGroup[] = [];
  private productsCache: Map<number, TCGProduct[]> = new Map();
  private pricesCache: Map<number, TCGPrice[]> = new Map();
  private allProductsWithPrices: ProductWithPrice[] = [];
  private fuse: Fuse<ProductWithPrice> | null = null;
  private lastFetchTime: number = 0;
  private cacheValidityMs = 6 * 60 * 60 * 1000; // 6 hours

  async fetchGroups(): Promise<TCGGroup[]> {
    const url = `${TCGCSV_BASE_URL}/tcgplayer/${POKEMON_CATEGORY_ID}/groups`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to fetch groups: ${response.status}`);
    }
    const data = await response.json();
    return data.results || data;
  }

  async fetchProducts(groupId: number): Promise<TCGProduct[]> {
    const url = `${TCGCSV_BASE_URL}/tcgplayer/${POKEMON_CATEGORY_ID}/${groupId}/products`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to fetch products for group ${groupId}: ${response.status}`);
    }
    const data = await response.json();
    return data.results || data;
  }

  async fetchPrices(groupId: number): Promise<TCGPrice[]> {
    const url = `${TCGCSV_BASE_URL}/tcgplayer/${POKEMON_CATEGORY_ID}/${groupId}/prices`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to fetch prices for group ${groupId}: ${response.status}`);
    }
    const data = await response.json();
    return data.results || data;
  }

  async initialize(forceRefresh = false): Promise<void> {
    const now = Date.now();
    if (!forceRefresh && this.allProductsWithPrices.length > 0 && now - this.lastFetchTime < this.cacheValidityMs) {
      console.log('Using cached product data');
      return;
    }

    console.log('Fetching Pokemon TCG data from tcgcsv.com...');

    // Fetch all groups
    this.groupsCache = await this.fetchGroups();
    console.log(`Fetched ${this.groupsCache.length} Pokemon TCG groups/sets`);

    // For sealed products (booster boxes, bundles, etc.), we need to look at specific groups
    // Filter for recent sets and sealed product groups
    const recentGroups = this.groupsCache
      .filter(g => {
        const publishDate = new Date(g.publishedOn);
        const oneYearAgo = new Date();
        oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 2);
        return publishDate > oneYearAgo;
      })
      .sort((a, b) => new Date(b.publishedOn).getTime() - new Date(a.publishedOn).getTime());

    console.log(`Processing ${recentGroups.length} recent groups...`);

    this.allProductsWithPrices = [];

    // Fetch products and prices for recent groups (with rate limiting)
    for (const group of recentGroups) {
      try {
        await this.delay(100); // Rate limiting

        const [products, prices] = await Promise.all([
          this.fetchProducts(group.groupId),
          this.fetchPrices(group.groupId)
        ]);

        const priceMap = new Map<number, TCGPrice[]>();
        for (const price of prices) {
          const existing = priceMap.get(price.productId) || [];
          existing.push(price);
          priceMap.set(price.productId, existing);
        }

        for (const product of products) {
          this.allProductsWithPrices.push({
            ...product,
            prices: priceMap.get(product.productId) || [],
            groupName: group.name
          });
        }

        this.productsCache.set(group.groupId, products);
        this.pricesCache.set(group.groupId, prices);
      } catch (error) {
        console.error(`Error fetching group ${group.name}:`, error);
      }
    }

    console.log(`Loaded ${this.allProductsWithPrices.length} products with prices`);
    this.lastFetchTime = now;

    // Initialize fuzzy search
    this.fuse = new Fuse(this.allProductsWithPrices, {
      keys: [
        { name: 'name', weight: 0.7 },
        { name: 'cleanName', weight: 0.5 },
        { name: 'groupName', weight: 0.3 }
      ],
      threshold: 0.4,
      includeScore: true,
      minMatchCharLength: 3
    });
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  searchProducts(query: string, limit = 5): ProductWithPrice[] {
    if (!this.fuse) {
      console.warn('Product data not initialized');
      return [];
    }

    // Clean up the query - remove common prefixes
    let cleanQuery = query
      .replace(/^Pok├⌐mon Trading Card Game:\s*/i, '')
      .replace(/^Pokemon Trading Card Game:\s*/i, '')
      .replace(/^PTCG:\s*/i, '')
      .replace(/ΓÇö/g, '-')
      .trim();

    const results = this.fuse.search(cleanQuery, { limit });
    return results.map(r => r.item);
  }

  formatPrice(product: ProductWithPrice): string {
    const prices = product.prices;
    if (!prices || prices.length === 0) {
      return 'No price data available';
    }

    // Get the main price (usually "Normal" or first available)
    const mainPrice = prices.find(p => p.subTypeName === 'Normal') || prices[0];

    const lines: string[] = [];

    if (mainPrice.marketPrice !== null) {
      lines.push(`Market: $${mainPrice.marketPrice.toFixed(2)}`);
    }
    if (mainPrice.lowPrice !== null) {
      lines.push(`Low: $${mainPrice.lowPrice.toFixed(2)}`);
    }
    if (mainPrice.midPrice !== null) {
      lines.push(`Mid: $${mainPrice.midPrice.toFixed(2)}`);
    }
    if (mainPrice.highPrice !== null) {
      lines.push(`High: $${mainPrice.highPrice.toFixed(2)}`);
    }

    return lines.join(' | ');
  }

  getProductUrl(product: ProductWithPrice): string {
    return product.url || `https://www.tcgplayer.com/product/${product.productId}`;
  }
}

export const tcgplayerService = new TCGPlayerService();
