from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit

class Panel(SimpleHTTPRequestHandler):
    def do_GET(self):
        path = unquote(urlsplit(self.path).path)
        if path not in ('/', '/index.html') and not (path.startswith('/assets/') and Path(self.translate_path(path)).resolve().is_relative_to(Path('assets').resolve()) and Path(self.translate_path(path)).is_file()):
            return self.send_error(404)
        super().do_GET()
    do_HEAD = do_GET

ThreadingHTTPServer(('0.0.0.0', 3000), Panel).serve_forever()
