import { SearchProvider, SearchResultItem } from '../interfaces.js';

export class MockSearchProvider implements SearchProvider {
  name = 'MockSearchProvider';

  async search(query: string, maxResults: number = 3): Promise<SearchResultItem[]> {
    const results: SearchResultItem[] = [
      {
        title: `Authoritative Analysis: ${query}`,
        url: 'https://www.nature.com/articles/35041703',
        snippet: 'Peer-reviewed technical examination of lateral resonance, footstep excitation, and structural damping in urban architecture.',
        sourceDomain: 'nature.com',
        publishedDate: '2005-11-03',
      },
      {
        title: `Official Engineering Report: ${query}`,
        url: 'https://www.arup.com/projects/millennium-bridge',
        snippet: 'Detailed civil engineering post-mortem covering initial opening diagnostics, vibration sensor deployment, and damper installation.',
        sourceDomain: 'arup.com',
        publishedDate: '2001-05-15',
      },
      {
        title: `Historical Retrospective: ${query}`,
        url: 'https://www.theguardian.com/uk/2000/jun/13/millenniumbridge',
        snippet: 'Contemporary press coverage of the bridge closure, public reaction, and preliminary engineering hypotheses.',
        sourceDomain: 'theguardian.com',
        publishedDate: '2000-06-13',
      },
    ];

    return results.slice(0, maxResults);
  }
}
