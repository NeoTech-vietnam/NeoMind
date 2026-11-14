"""OpenAI-compatible, predetermined fake response; listens only on IPv4 loopback."""
import argparse
import json
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        data = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        if self.path != '/v1/chat/completions' or data.get('model') != 'fake-review':
            self.send_error(403)
            return
        with self.server.trace.open('a') as trace:
            trace.write(json.dumps({'path': self.path, 'model': data.get('model'), 'stream': data.get('stream')}) + '\n')
        result = json.dumps({'verdict':'needs_changes','findings':[{'description':'Fixture fake finding','path':'source.txt'}],'summary':'Fake upstream review'})
        if data.get('stream'):
            self.send_response(200)
            self.send_header('Content-Type','text/event-stream')
            self.end_headers()
            event = {'id':'wire','object':'chat.completion.chunk','created':0,'model':'fake-review','choices':[{'index':0,'delta':{'role':'assistant','content':result},'finish_reason':'stop'}]}
            self.wfile.write(('data: '+json.dumps(event)+'\n\ndata: [DONE]\n\n').encode())
            return
        body = json.dumps({'id':'wire','object':'chat.completion','created':0,'model':'fake-review','choices':[{'index':0,'message':{'role':'assistant','content':result},'finish_reason':'stop'}]}).encode()
        self.send_response(200)
        self.send_header('Content-Type','application/json')
        self.send_header('Content-Length',str(len(body)))
        self.end_headers()
        self.wfile.write(body)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--port', type=int, required=True)
    parser.add_argument('--trace', type=Path, required=True)
    args = parser.parse_args()
    server = HTTPServer(('127.0.0.1', args.port), Handler)
    server.trace = args.trace
    server.serve_forever()
