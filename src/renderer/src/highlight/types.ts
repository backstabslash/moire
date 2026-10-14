export type Tok = [text: string, color: string, fontStyle: number];
export type TokLines = Tok[][];

export interface HighlightRequest {
  id: number;
  lang: string;
  texts: (string | null)[];
}

export interface HighlightResponse {
  id: number;
  sides: (TokLines | null)[];
}
