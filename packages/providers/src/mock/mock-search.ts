import type { PageRetriever, RetrievedSourceContent, SearchOptions, SearchProvider, SearchResultItem } from '../interfaces.js';

/** Fixed documents with verifiable sentences; mock research quotes from these verbatim. */
export const MOCK_DOCUMENTS: SearchResultItem[] = [
  {
    title: 'Millennium Bridge opening and closure',
    url: 'https://mock.invalid/sources/millennium-bridge-history',
    snippet: 'The London Millennium Footbridge opened on 10 June 2000 and closed two days later.',
    sourceDomain: 'mock.invalid',
    rawContent:
      'The London Millennium Footbridge opened to the public on 10 June 2000. ' +
      'An estimated 90,000 people crossed the bridge on its opening day. ' +
      'The bridge was closed on 12 June 2000 after pedestrians noticed an unexpected sideways swaying motion. ' +
      'Engineers attributed the movement to synchronous lateral excitation caused by footsteps falling into step with the sway. ' +
      'The bridge remained closed for almost two years while modifications were designed and installed.',
  },
  {
    title: 'Engineering the fix',
    url: 'https://mock.invalid/sources/millennium-bridge-dampers',
    snippet: 'Engineers installed 37 viscous dampers and 52 tuned mass dampers.',
    sourceDomain: 'mock.invalid',
    rawContent:
      'To stop the wobble, engineers installed 37 viscous dampers and 52 tuned mass dampers beneath the deck. ' +
      'The retrofit cost about 5 million pounds. ' +
      'The Millennium Bridge reopened on 22 February 2002 and has not swayed noticeably since. ' +
      'The phenomenon had been documented before on other bridges, but it had never been studied at this scale. ' +
      'Tests with groups of walkers on the deck showed that the swaying began once enough people crossed at the same time.',
  },
];

/** Mock mode never touches the network. */
export class MockPageRetriever implements PageRetriever {
  async retrieveUrl(url: string): Promise<RetrievedSourceContent> {
    return { url, title: '', cleanText: '', contentLength: 0, statusCode: 0, retrievedAt: new Date().toISOString(), error: 'mock mode: no network retrieval' };
  }
}

export class MockSearchProvider implements SearchProvider {
  readonly name = 'mock-search';

  async search(query: string, opts: SearchOptions): Promise<SearchResultItem[]> {
    if (!query.trim()) return [];
    return MOCK_DOCUMENTS.slice(0, opts.maxResults).map((d) => ({ ...d, rawContent: opts.includeRawContent ? d.rawContent : undefined }));
  }
}
