# Kitchen Arena decision service

A restaurant sends this service every incoming order and asks one question:
**accept it or not?** The service answers in under 10 seconds with a decision,
a promised ready time, and an allergy flag. It is scored in AED at the end of
each 240-minute shift.

```
Restaurant ──POST /kitchen──▶ this service ──JSON──▶ {"decision": "accept", "promised_minutes": 12, "allergy_risk": true}
```

Node 22, no dependencies. One process. Ships as a Docker image.

## How it decides

Every order goes through the same steps, in this order. The free checks run
first, so a model call is only spent when it can change the answer.

| Step | Question | If no |
|---|---|---|
| 1 | Do we still have every ingredient? | reject |
| 2 | Can it be cooked before the shift ends? | reject |
| 3 | Read the note: allergy conflict, deadline, key account, cancel risk | |
| 4 | Does the note say the customer may not be there? (not for key accounts) | reject |
| 5 | Ready time from the 4-station queue, plus 2 minutes. Is it within 30? | reject, unless key account and lateness is cheaper than losing them |
| 6 | Does it meet a deadline the customer wrote? | tighten the promise, or reject |
| 7 | Accept: hold the ingredients, book a station, reply | |

Rejecting an ordinary order costs nothing. A bad accept costs two to five
hundred AED. So the service says no whenever it is unsure about the kitchen.

## The three parts

**`ledger.js`** keeps the service's own picture of the kitchen, because the
restaurant never sends it with an order. Stock goes down on every accept and
is overwritten by the 30-minute inventory snapshot. Four stations are
simulated first come, first served, and every cooking-started, delivered,
failed and cancelled event corrects the picture.

**`notes.js`** turns the customer's free text into four facts using Gemini
(3.1 Flash Lite, 3.5 Flash as backup). Five pure logistics phrases are skipped.
Repeated notes are cached. If the model is slow, down or rate-limited, a
keyword rule answers instead, so the reply never waits on the model.

**`decide.js`** applies the seven steps above. **`server.js`** handles the
HTTP contract, checks the request signature when a secret is set, and resets
everything when a new run starts.

## Run it

```bash
cp .env.example .env        # add GEMINI_API_KEY
export $(grep -v '^#' .env | xargs)
node server.js              # http://localhost:8080
npm test                    # 14 tests, no network needed
```

## Docker

```bash
docker build -t kitchen-arena-service .
docker run --rm -p 8080:8080 --env-file .env kitchen-arena-service
curl localhost:8080/        # {"ok":true,...}
```

The image is 22-slim plus five files, runs as the unprivileged `node` user,
and reads `PORT` from the environment so any host can set it.

## Deploy to Cloudflare Workers (fixed URL, free)

`worker.js` wraps the same three modules in a Worker. A Durable Object named
`kitchen` holds the ledger, which gives the single instance the arena requires
and survives restarts because it writes its state after every event.

```bash
npx wrangler login                          # once, opens the browser
npx wrangler secret put GEMINI_API_KEY      # paste the key
npx wrangler deploy                         # prints https://kitchen-arena-service.<account>.workers.dev
```

Local test without deploying: put `GEMINI_API_KEY=...` in `.dev.vars` and run
`npx wrangler dev --port 8787 --local`.

## Deploy with Docker on Render

`render.yaml` is a Render Blueprint that builds this Dockerfile. In the Render
dashboard choose **New → Blueprint**, pick this repo, and paste
`GEMINI_API_KEY` when asked. Then set the repository variable `SERVICE_URL` to
the Render address so the keep-warm workflow pings it every 5 minutes.
Render's free tier sleeps after 15 idle minutes and takes longer than 10
seconds to wake.

The same image runs on Hugging Face Spaces (Docker) or any container host.
Set `PORT` to what the host expects (Spaces uses 7860).

## Environment

| Variable | Default | Purpose |
|---|---|---|
| `GEMINI_API_KEY` | none | Google AI Studio key. Without it the keyword rule runs alone. |
| `GEMINI_MODEL` | `gemini-3.1-flash-lite` | Primary model |
| `GEMINI_FALLBACK_MODEL` | `gemini-3.5-flash` | Tried on 5xx or 404 |
| `IMDAD_SIGNING_SECRET` | none | Enables HMAC signature checks |
| `PORT` | `8080` | Listen port |

## Results

Same 150 practice orders, three runs.

| | Run 1, before fixes | Run 2 | Run 3 |
|---|---|---|---|
| Score | 1,549 AED | 3,848 AED | see dashboard |
| Missed allergies | 4 | 0 | 0 |
| False allergy flags | 1 | 0 | 0 |
| Key accounts rejected | 1 | 0 | 0 |
| Cancelled after cooking | 6 | 1 | 1 |
| Late minutes | 0 | 2 | 2 |

The untouched starter code, which accepts everything, scores about
−15,400 AED on the same orders.
