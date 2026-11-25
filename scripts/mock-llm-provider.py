# Provider LLM factice, compatible OpenAI, pour la VALIDATION SUR MOTEUR RÉEL
# (scripts/test-gateway-reel.ts). Le moteur hermes-agent tourne à 100 % pour
# de vrai (gateway, sessions, protocole) ; seul le backend modèle est simulé
# sur loopback — même recette que les e2e Desktop du moteur
# (apps/desktop/e2e/core/provider.ts).
#
# Contrat servi :
#   GET  /v1/models            → liste mock-model
#   POST /v1/chat/completions  → SSE en streaming (ou JSON si stream=false)
#
# Scénarios pilotés par le DERNIER message utilisateur (mots-clés du harnais) :
#   « interrompre » → 12 segments espacés de 400 ms (tour lent, interrompu
#                     en plein flux par chat:stop) ;
#   « coupé »       → 12 segments espacés de 400 ms (le harnais tue le moteur
#                     en plein flux) ;
#   sinon           → 5 segments espacés de 120 ms (tour nominal rapide).
# Chaque réponse porte le marqueur MOTEUR-RÉEL-OK : le harnais vérifie que le
# texte final autoritaire rendu par l'interface le contient (la chaîne
# complet est passée par le VRAI moteur, pas par une passerelle simulée).
#
# Aucune dépendance externe : http.server + threading de la stdlib.

import json
import re
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

MARKER = "MOTEUR-RÉEL-OK"
SLOW_SEGMENT_COUNT = 12
SLOW_DELAY = 0.4
FAST_SEGMENT_COUNT = 5
FAST_DELAY = 0.12


def last_user_content(messages):
    for msg in reversed(messages):
        role = str(msg.get("role", "")).lower()
        content = msg.get("content")
        if role == "user" and content:
            if isinstance(content, str):
                return content
            if isinstance(content, list):
                parts = [p.get("text", "") for p in content
                         if isinstance(p, dict) and isinstance(p.get("text"), str)]
                if parts:
                    return "\n".join(parts)
    return ""


def plan_reply(user_text):
    if "interrompre" in user_text:
        segments, delay = SLOW_SEGMENT_COUNT, SLOW_DELAY
        label = "lent"
    elif "coupé" in user_text:
        segments, delay = SLOW_SEGMENT_COUNT, SLOW_DELAY
        label = "coupé"
    else:
        segments, delay = FAST_SEGMENT_COUNT, FAST_DELAY
        label = "nominal"
    words = [f"segment-{i + 1}" for i in range(segments)]
    words.append(MARKER)
    text = f"Réponse {label} du moteur réel ({segments} segments) : " + " ".join(words) + "."
    # Découpe en ~segments morceaux, marqueur dans le dernier tiers.
    n = segments + 1
    size = max(1, (len(text) + n - 1) // n)
    chunks = [text[i:i + size] for i in range(0, len(text), size)]
    return chunks, delay


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):  # silencieux : le harnais lit son propre log
        pass

    def _json(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.startswith("/v1/models"):
            self._json(200, {
                "object": "list",
                "data": [{"id": "mock-model", "object": "model",
                          "created": 0, "owned_by": "validation-reelle"}],
            })
        else:
            self._json(404, {"error": {"message": f"not found: {self.path}"}})

    def do_POST(self):
        if not self.path.startswith("/v1/chat/completions"):
            self._json(404, {"error": {"message": f"not found: {self.path}"}})
            return
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b""
        try:
            body = json.loads(raw or b"{}")
        except json.JSONDecodeError:
            body = {}
        messages = body.get("messages") if isinstance(body.get("messages"), list) else []
        model = body.get("model") if isinstance(body.get("model"), str) else "mock-model"
        chunks, delay = plan_reply(last_user_content(messages))
        print(f"[provider] completions model={model} user={last_user_content(messages)[:60]!r}"
              f" → {len(chunks)} segments × {delay * 1000:.0f} ms", flush=True)

        if body.get("stream") is not True:
            full = "".join(chunks)
            self._json(200, {
                "id": "chatcmpl-validation", "object": "chat.completion", "created": 0,
                "model": model,
                "choices": [{"index": 0, "finish_reason": "stop",
                             "message": {"role": "assistant", "content": full}}],
                "usage": {"prompt_tokens": 10, "completion_tokens": 10, "total_tokens": 20},
            })
            return

        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")
        self.end_headers()
        try:
            for i, chunk in enumerate(chunks):
                payload = {
                    "id": "chatcmpl-validation", "object": "chat.completion.chunk",
                    "created": 0, "model": model,
                    "choices": [{"index": 0,
                                 "delta": ({"role": "assistant", "content": ""}
                                           if i == 0 else {"content": chunk}),
                                 "finish_reason": None}],
                }
                self.wfile.write(f"data: {json.dumps(payload)}\n\n".encode("utf-8"))
                self.wfile.flush()
                time.sleep(delay)
            tail = {
                "id": "chatcmpl-validation", "object": "chat.completion.chunk",
                "created": 0, "model": model,
                "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
            }
            self.wfile.write(f"data: {json.dumps(tail)}\n\n".encode("utf-8"))
            self.wfile.write(b"data: [DONE]\n\n")
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            print("[provider] flux interrompu par le moteur (attendu en abort)",
                  flush=True)


def main():
    # Port fixe passé par le harnais (9351) : le config.yaml du HERMES_HOME
    # pointe dessus, il doit donc être stable d'une exécution à l'autre.
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 0
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(server.server_address[1], flush=True)  # ligne 1 = port, lue par le harnais
    server.serve_forever()


if __name__ == "__main__":
    sys.exit(main())
