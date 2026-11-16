"""Owned fake OpenAI-compatible server; logs metadata only."""
import json
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

root = Path(sys.argv[1])

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        data = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        with (root / 'upstream.jsonl').open('a') as log:
            log.write(json.dumps({'path': self.path, 'model': data.get('model')}) + '\n')
        mode = (root / 'upstream-mode').read_text().strip()
        if mode == 'slow':
            time.sleep(5)
        if mode == '429':
            self.send_response(429)
            self.send_header('Content-Length', '0')
            self.end_headers()
            return
        if mode == 'cycle' and '90 days' not in json.dumps(data.get('messages', [])):
            result = json.dumps({'verdict': 'pass', 'findings': [], 'summary': 'Synthetic corrected draft'})
        else:
            result = json.dumps({'verdict': 'needs_changes', 'findings': [{'description': 'Synthetic fake finding', 'path': 'source.txt'}], 'summary': 'Synthetic fake review'})
        event = {'id': 'wire', 'object': 'chat.completion.chunk', 'created': 0, 'model': 'fake-review', 'choices': [{'index': 0, 'delta': {'role': 'assistant', 'content': result}, 'finish_reason': 'stop'}]}
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.end_headers()
        try:
            self.wfile.write(('data: ' + json.dumps(event) + '\n\ndata: [DONE]\n\n').encode())
        except (BrokenPipeError, ConnectionResetError):
            pass

server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
print(server.server_port, flush=True)
server.serve_forever()
