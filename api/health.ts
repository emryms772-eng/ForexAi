interface ServerlessRequest {
  method?: string;
}

interface ServerlessResponse {
  status: (code: number) => ServerlessResponse;
  json: (body: unknown) => void;
}

export default function handler(_req: ServerlessRequest, res: ServerlessResponse) {
  res.status(200).json({ status: 'ok', runtime: 'vercel', timestamp: new Date().toISOString() });
}
