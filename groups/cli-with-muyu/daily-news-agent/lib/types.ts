export interface NewsItem {
  id: string;
  source: 'hn' | 'rss';
  title: string;
  url: string;
  publishedAt: string;
  score: number;
  feedId: string;
}

export interface FetchPayload {
  fetchedAt: string;
  timezone: string;
  windowHours: number;
  items: NewsItem[];
  errors: Array<{ source: string; message: string }>;
}

export interface ScriptResult {
  wakeAgent: boolean;
  data?: FetchPayload;
}

export interface FeedsConfig {
  feeds: Array<{
    id: string;
    type: 'rss';
    url: string;
    maxItems: number;
  }>;
  hn: { topStories: number };
  windowHours: number;
}
