declare module 'elkjs/lib/elk.bundled.js' {
  export interface ElkPoint {
    x: number;
    y: number;
  }

  export interface ElkNode {
    id: string;
    width?: number;
    height?: number;
    x?: number;
    y?: number;
    children?: ElkNode[];
    edges?: ElkExtendedEdge[];
    layoutOptions?: Record<string, string>;
  }

  export interface ElkExtendedEdge {
    id: string;
    sources: string[];
    targets: string[];
    sections?: Array<{
      startPoint: ElkPoint;
      endPoint: ElkPoint;
      bendPoints?: ElkPoint[];
    }>;
  }

  export default class ELK {
    constructor(options?: Record<string, unknown>);
    layout(graph: ElkNode, options?: Record<string, unknown>): Promise<ElkNode>;
  }
}
