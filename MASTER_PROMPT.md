# Master prompt — AudioTool

Ești un senior full-stack engineer, arhitect software, inginer audio/DSP și ML engineer. Construiește în workspace-ul curent o aplicație web completă numită **AudioTool**, orientată spre separarea inteligentă a unei melodii în stem-uri pentru fiecare instrument detectat și spre editarea audio în browser.

Nu crea doar o demonstrație vizuală. Livrează o aplicație funcțională, modulară, testabilă și pregătită pentru dezvoltare locală și extindere în producție. Lucrează incremental, verifică fiecare etapă și nu declara o funcție finalizată dacă folosește date false, butoane fără comportament sau endpoint-uri neimplementate.

## Context deja existent

- Workspace: `D:\JSprojects\AudioTool`
- PostgreSQL 18 este instalat local.
- Baza de date goală `audio_tool` a fost deja creată în pgAdmin.
- Nu recrea și nu șterge baza de date.
- Nu executa `DROP DATABASE`, `DROP SCHEMA`, resetări distructive sau ștergeri globale de date.
- Citește conexiunea exclusiv din variabile de mediu. Creează `.env.example`, dar nu introduce parole reale în repository.
- Stack-ul principal cerut este TypeScript, Vue și Node.js. Python este permis numai într-un serviciu ML separat, deoarece modelele moderne de separare audio folosesc în principal PyTorch/CUDA.

## Obiectivul produsului

Utilizatorul trebuie să poată încărca o melodie, iar sistemul să:

1. analizeze fișierul;
2. detecteze automat instrumentele prezente și scorul de încredere pentru fiecare;
3. afișeze lista pentru confirmare și corectare manuală;
4. separe fiecare categorie de instrument selectată într-un stem propriu;
5. genereze un stem `other/residual` pentru materialul audio neatribuit;
6. deschidă stem-urile într-un mixer multitrack;
7. permită ascultarea, reglarea și exportarea fiecărui stem sau a mixului final.

Nu limita aplicația la schema clasică `vocals / drums / bass / other`. Arhitectura trebuie să permită un număr dinamic de stem-uri.

Exemple de categorii suportate:

- lead vocals;
- backing vocals;
- drums;
- percussion;
- bass guitar;
- synth bass;
- acoustic guitar;
- electric guitar;
- piano;
- electric piano;
- organ;
- synthesizer/pad;
- strings;
- brass;
- woodwinds/reeds;
- saxophone;
- flute;
- other/residual.

În prima versiune, stem-ul reprezintă categoria instrumentului. Nu promite separarea perfectă a două instanțe ale aceluiași instrument. Proiectează însă API-ul astfel încât ulterior să poată exista `electric_guitar_1`, `electric_guitar_2`, `lead_vocal` și `backing_vocals`.

## Funcționalități obligatorii

### 1. Proiecte și fișiere audio

- Creare, redenumire, listare și ștergere controlată a proiectelor.
- Upload prin drag-and-drop și selector de fișiere.
- Formate de intrare: WAV, MP3, FLAC, M4A/AAC, OGG și WebM atunci când FFmpeg le poate decoda.
- Validare MIME, extensie, dimensiune și durată.
- Calcul SHA-256 pentru deduplicare și integritate.
- Extragere metadate cu `ffprobe`: durată, codec, sample rate, canale și bitrate.
- Fișierele audio nu se stochează în PostgreSQL. În development folosește un director local configurabil; proiectează un adapter pentru S3/R2/MinIO în producție.
- Folosește nume interne UUID, nu numele original ca path fizic.
- Protejează împotriva path traversal și upload-urilor invalide.

### 2. Detectarea instrumentelor

- Creează un serviciu ML cu un contract stabil, independent de model.
- Rezultatul detecției trebuie să conțină cel puțin:
  - eticheta canonică;
  - denumirea afișată;
  - scorul de încredere între 0 și 1;
  - intervalele temporale probabile, dacă modelul le furnizează;
  - modelul și versiunea utilizată.
- Normalizează sinonimele: de exemplu `kit`, `drum kit` și `drums` devin `drums`.
- Utilizatorul poate include, exclude sau adăuga manual un instrument înainte de separare.
- Etichetele cu încredere redusă trebuie marcate vizibil ca incerte.
- Nu folosi un LLM pentru a pretinde că a ascultat fișierul. Un LLM poate normaliza texte, dar detecția trebuie făcută de un model audio real.

### 3. Separarea dinamică în stem-uri

- Definește interfața `StemSeparationProvider`, astfel încât modelele să poată fi schimbate fără modificarea API-ului principal.
- Prevede provideri/adaptoare pentru:
  - un model muzical query-conditioned precum Banquet pentru instrumente cunoscute;
  - SAM-Audio sau AudioSep pentru separare pe baza unei descrieri text;
  - Demucs ca fallback pentru clasele standard;
  - un provider mock exclusiv pentru dezvoltarea UI și teste automate.
- Providerul real trebuie selectat din configurație, nu hardcodat.
- Pentru fiecare instrument selectat generează un fișier stem și metadatele aferente.
- Generează sau păstrează un stem residual. Verifică faptul că reconstrucția stem-urilor este cât mai apropiată de mixul original.
- Salvează informații despre model, versiune, prompt/query, timp de procesare și eventualele erori.
- Permite retry numai pentru instrumentul eșuat, fără refacerea întregului proiect.
- Procesarea trebuie să fie asincronă. Endpoint-ul HTTP nu trebuie să rămână deschis pe durata inferenței.
- Publică progresul prin SSE; WebSocket este acceptabil dacă există un motiv tehnic clar.
- Permite anularea jobului.
- Limitează concurența în funcție de resursele GPU.
- Dacă modelele sau checkpoint-urile nu sunt disponibile local, implementează complet contractele, worker-ul, configurarea și modul mock, apoi documentează exact cum se instalează modelul real. Nu simula rezultate reale și nu ascunde lipsa modelului.

### 4. Mixer multitrack

- Creează automat o pistă pentru fiecare stem.
- Waveform vizibil pentru fiecare pistă.
- Play, pause, stop, seek și playhead sincronizat.
- Solo, mute, volum, pan și reset pentru fiecare pistă.
- Drag orizontal pentru poziția clipului pe timeline.
- Trim la început și sfârșit.
- Fade in și fade out.
- Ștergere/reintroducere pistă fără ștergerea fișierului sursă.
- Master volume și protecție împotriva clipping-ului.
- Meter simplu de nivel pentru piste și master.
- Zoom pe timeline.
- Export mix final WAV; pregătește backend-ul pentru MP3/FLAC.
- Export individual și download ZIP pentru toate stem-urile.
- Previzualizarea poate folosi Web Audio API, AudioWorklet și Web Workers. Randarea finală trebuie să poată fi făcută reproductibil cu FFmpeg pe backend.

### 5. Vocal remover și separator rapid

- Mod rapid cu două rezultate: `vocals` și `instrumental`.
- Mod standard pentru stem-uri comune.
- Mod avansat `Auto-detect instruments`, care generează numărul dinamic de stem-uri.
- Toate cele trei moduri trebuie să folosească aceeași infrastructură de joburi și aceeași pagină de rezultate.

### 6. Pitch și tempo

- Detectează cheia, scala și BPM-ul cu un algoritm audio real.
- Permite modificarea independentă a pitch-ului în semitonuri și a tempo-ului.
- Pitch-ul nu trebuie legat obligatoriu de viteza de redare.
- Afișează cheia/BPM originale și valorile rezultate.
- Oferă preview și export.
- Izolează biblioteca de time-stretch/pitch-shift în spatele unui adapter și documentează licența. Nu integra într-un produs proprietar o bibliotecă GPL/AGPL fără să avertizezi explicit.

### 7. Key & BPM finder

- Upload pentru unul sau mai multe fișiere.
- Rezultat: key, major/minor, BPM, confidence și durata analizei.
- Corecție pentru ambiguități half-time/double-time, de exemplu 70 vs 140 BPM.
- Export rezultate CSV/JSON.
- Buton `Open in Pitch & Tempo` cu valorile precompletate.

### 8. Audio cutter

- Waveform cu selecție precisă.
- Păstrarea sau eliminarea selecției.
- Mai multe regiuni.
- Fade in/out configurabil.
- Preview înainte de export.
- Export WAV, MP3 și FLAC când codecurile sunt disponibile.
- Procesare locală pentru preview; FFmpeg pentru randare finală sau fișiere mari.

### 9. Audio joiner

- Adăugare mai multe fișiere.
- Reordonare drag-and-drop.
- Trim individual.
- Pauză configurabilă sau crossfade între fișiere.
- Normalizare opțională.
- Preview și export.

### 10. Istoric, erori și observabilitate

- Pagină cu proiecte și joburi recente.
- Statusuri clare: queued, detecting, awaiting_confirmation, separating, rendering, completed, failed, cancelled.
- Mesaje de eroare utile pentru utilizator, fără stack traces sau paths interne.
- Logging structurat cu request ID și job ID.
- Health endpoints pentru API, PostgreSQL, Redis, FFmpeg, storage și ML worker.
- Curățare configurabilă a fișierelor temporare și a proiectelor expirate.

## Stack tehnic

Folosește un monorepo `pnpm`:

```text
apps/
  web/                 Vue 3 + TypeScript + Vite
  api/                 Node.js + TypeScript + Fastify
  ml-worker/           Python 3.11+ + FastAPI/PyTorch
packages/
  contracts/           DTO-uri, enums și scheme comune
  database/            Drizzle schema și migrations
  audio-engine/        builder pentru operații FFmpeg
  config/              validare variabile de mediu
infra/
  docker/
  compose.yaml
docs/
```

În frontend folosește:

- Vue 3 Composition API și `<script setup lang="ts">`;
- Vue Router;
- Pinia;
- TanStack Query pentru starea serverului;
- o bibliotecă matură pentru waveform sau un wrapper propriu peste Web Audio/Canvas;
- CSS responsive și accesibil; nu copia identitatea vizuală a site-urilor de referință.

În backend folosește:

- Fastify;
- Zod pentru validare;
- Drizzle ORM și migrations;
- BullMQ + Redis pentru joburi;
- SSE pentru progres;
- FFmpeg/ffprobe prin procese copil cu argumente sigure, fără comenzi shell construite din input-ul utilizatorului;
- OpenAPI/Swagger pentru documentarea API-ului.

Nu bloca event loop-ul Node cu procesare audio grea.

## PostgreSQL

Conectează-te la baza existentă `audio_tool` folosind ceva similar cu:

```env
DATABASE_URL=postgresql://USER:PASSWORD@localhost:5432/audio_tool
```

Creează migrations versionate pentru cel puțin următoarele entități:

### `users`

- id UUID PK;
- email unic;
- password_hash nullable dacă autentificarea nu este activată inițial;
- display_name;
- role;
- created_at, updated_at.

### `projects`

- id UUID PK;
- user_id FK nullable pentru development single-user;
- name;
- status;
- source_audio_id FK nullable;
- created_at, updated_at, deleted_at.

### `audio_assets`

- id UUID PK;
- project_id FK;
- kind: source, stem, preview, mix, export;
- storage_provider;
- storage_key;
- original_filename;
- mime_type;
- extension;
- size_bytes;
- checksum_sha256;
- duration_ms;
- sample_rate;
- channels;
- codec;
- metadata JSONB;
- created_at, deleted_at.

### `instrument_detections`

- id UUID PK;
- project_id FK;
- canonical_label;
- display_label;
- confidence numeric;
- detected_spans JSONB;
- selected boolean;
- manually_added boolean;
- model_name;
- model_version;
- created_at, updated_at.

### `separation_jobs`

- id UUID PK;
- project_id FK;
- mode;
- status;
- progress integer 0–100;
- current_stage;
- provider;
- model_name și model_version;
- error_code și error_message;
- queued_at, started_at, finished_at, cancelled_at;
- options JSONB.

### `stems`

- id UUID PK;
- project_id FK;
- job_id FK;
- audio_asset_id FK;
- instrument_detection_id FK nullable;
- canonical_label;
- instance_index;
- confidence nullable;
- is_residual boolean;
- processing_metadata JSONB;
- created_at.

### `mix_sessions`

- id UUID PK;
- project_id FK;
- name;
- master_settings JSONB;
- created_at, updated_at.

### `mix_tracks`

- id UUID PK;
- mix_session_id FK;
- stem_id FK nullable;
- audio_asset_id FK;
- order_index;
- start_ms;
- trim_start_ms;
- trim_end_ms;
- volume_db;
- pan;
- muted, solo;
- fade_in_ms, fade_out_ms;
- settings JSONB;
- created_at, updated_at.

### `analysis_results`

- id UUID PK;
- audio_asset_id FK;
- analysis_type;
- result JSONB;
- model_or_algorithm;
- version;
- confidence nullable;
- created_at.

### `processing_events`

- id BIGSERIAL PK;
- job_id FK;
- level;
- event_type;
- message;
- data JSONB;
- created_at.

Adaugă indecși pe foreign keys, statusuri, `created_at`, checksum și coloanele folosite la listare. Folosește constrângeri pentru confidence, progress, volume/pan și durate pozitive. Folosește tranzacții la schimbările de status și la înregistrarea rezultatelor.

## Contract API orientativ

Implementează și documentează minimum:

```text
POST   /api/projects
GET    /api/projects
GET    /api/projects/:projectId
PATCH  /api/projects/:projectId
DELETE /api/projects/:projectId

POST   /api/projects/:projectId/audio
GET    /api/audio/:assetId
GET    /api/audio/:assetId/stream

POST   /api/projects/:projectId/detect-instruments
GET    /api/projects/:projectId/detections
PATCH  /api/projects/:projectId/detections

POST   /api/projects/:projectId/separation-jobs
GET    /api/jobs/:jobId
POST   /api/jobs/:jobId/cancel
POST   /api/jobs/:jobId/retry
GET    /api/jobs/:jobId/events

GET    /api/projects/:projectId/stems
GET    /api/stems/:stemId/download
GET    /api/projects/:projectId/stems.zip

GET    /api/projects/:projectId/mix
PUT    /api/projects/:projectId/mix
POST   /api/projects/:projectId/render

POST   /api/tools/analyze-key-bpm
POST   /api/tools/pitch-tempo
POST   /api/tools/cut
POST   /api/tools/join

GET    /health
GET    /ready
```

Folosește DTO-uri comune și răspunsuri consistente. Operațiile asincrone trebuie să returneze `202 Accepted` și ID-ul jobului.

## Interfață și experiență

Creează următoarele pagini:

```text
/
/projects
/projects/new
/projects/:id/analyze
/projects/:id/instruments
/projects/:id/separation
/projects/:id/mixer
/tools/vocal-remover
/tools/splitter
/tools/pitch-tempo
/tools/key-bpm
/tools/cutter
/tools/joiner
```

Fluxul principal trebuie să fie foarte clar:

```text
Upload → Analyze → Confirm instruments → Separate → Mix/Download
```

Folosește skeleton states, progres pe etape, empty states și mesaje accesibile. UI-ul trebuie să funcționeze pe desktop și mobil, dar mixerul poate recomanda desktop pentru editare complexă.

## Groq

Integrarea Groq este opțională și nu trebuie folosită ca motor de separare. Poate fi implementată ulterior pentru:

- transcrierea stem-ului vocal prin Whisper;
- timestamps și subtitrări;
- traducere;
- comenzi text pentru interfață;
- normalizarea descrierilor introduse de utilizator.

Nu trimite fișiere către Groq fără consimțământ și fără o setare explicită. Funcțiile principale trebuie să funcționeze fără Groq.

## Licențe și conformitate

Înainte de integrarea fiecărui model sau DSP:

- verifică licența codului și separat licența checkpoint-ului;
- documentează dacă utilizarea comercială este permisă;
- nu presupune că o licență permisivă a repository-ului acoperă automat greutățile modelului;
- marchează clar componentele GPL/AGPL sau non-commercial;
- păstrează o listă `docs/THIRD_PARTY_LICENSES.md`;
- nu copia UI-ul, branding-ul, textele sau asset-urile vocalremover.org ori ale altor servicii.

## Testare

Implementează:

- unit tests pentru validare, normalizare etichete și FFmpeg command builder;
- integration tests pentru API și PostgreSQL;
- teste pentru tranzițiile joburilor și retry/cancel;
- teste E2E pentru fluxul upload → detectare mock → confirmare → separare mock → mixer;
- un fixture audio scurt, generat sau licențiat corespunzător;
- verificare că toate stem-urile apar în mixer;
- verificare că mix session se salvează și se reîncarcă;
- lint, typecheck și build pentru toate pachetele.

Nu folosi fișiere audio comerciale în repository.

## Docker și dezvoltare locală

Creează `compose.yaml` pentru Redis, storage local compatibil S3 și, opțional, PostgreSQL. Deoarece utilizatorul are deja PostgreSQL și baza `audio_tool`, profilul implicit trebuie să permită folosirea bazei de pe host fără a porni alt PostgreSQL.

Documentează particularitățile Docker Desktop pe Windows pentru accesarea host-ului. Nu presupune că `localhost` din container indică host-ul.

Creează comenzi clare:

```text
pnpm install
pnpm db:generate
pnpm db:migrate
pnpm dev
pnpm test
pnpm typecheck
pnpm build
```

Pentru worker-ul ML documentează mediul Python, CUDA, checkpoint-urile, memoria GPU necesară și modul CPU/mock.

## Ordinea de implementare

Lucrează în aceste etape și verifică fiecare etapă înainte de următoarea:

1. Inspectarea workspace-ului și verificarea versiunilor Node/pnpm/Python/FFmpeg/PostgreSQL.
2. Monorepo, config, `.env.example`, lint, formatting și contracte comune.
3. Schema Drizzle și migrations pentru baza existentă `audio_tool`.
4. API pentru proiecte, upload, metadata și streaming.
5. Redis/BullMQ, state machine pentru joburi și SSE.
6. Interfața ML, provider mock și serviciul Python.
7. Flux E2E cu detecție și separare mock, fără a pretinde inferență reală.
8. Integrarea și benchmark-ul unui model real pe fișiere de test autorizate.
9. Mixerul multitrack și salvarea sesiunii.
10. Randare și export FFmpeg.
11. Cutter, joiner, key/BPM și pitch/tempo.
12. Teste, documentație, securitate, observabilitate și optimizare.

## Reguli de lucru

- Înainte de modificări, inspectează fișierele existente și păstrează schimbările utilizatorului.
- Prezintă un plan scurt, apoi implementează; nu te opri după plan dacă nu există un blocaj real.
- Folosește TypeScript strict și evită `any`.
- Nu hardcoda credențiale, paths locale sau secrete.
- Nu instala dependențe neverificate doar pentru a evita implementarea unei funcții mici.
- Nu construi comenzi shell prin concatenarea input-ului utilizatorului.
- Nu încărca automat fișierele utilizatorului la servicii terțe.
- Nu șterge baza existentă și nu modifica alte baze PostgreSQL.
- Migrations trebuie să fie idempotente în cadrul mecanismului Drizzle și aplicate numai bazei configurate.
- Dacă este necesară o alegere cu impact mare, explică opțiunile; altfel folosește valorile implicite din acest prompt.
- După fiecare etapă rulează testele relevante și remediază erorile introduse.
- La final raportează exact ce funcționează real, ce rulează în mock, ce necesită GPU/checkpoint și ce rămâne de făcut.

## Criterii de acceptare pentru primul milestone

Primul milestone este acceptat numai dacă:

1. aplicația pornește local cu instrucțiunile din README;
2. API-ul se conectează la baza `audio_tool` prin `DATABASE_URL`;
3. migrations creează schema fără operații distructive;
4. utilizatorul poate crea un proiect și încărca un fișier audio;
5. metadata fișierului este extrasă și salvată;
6. providerul mock detectează o listă dinamică de instrumente;
7. utilizatorul poate modifica selecția;
8. un job asincron generează stem-uri mock etichetate corect;
9. progresul este afișat în timp real;
10. stem-urile apar în mixer cu play, mute, solo și volum;
11. proiectul și setările mixerului persistă după refresh;
12. testele, typecheck-ul și build-ul trec;
13. README diferențiază clar funcțiile reale de providerul ML mock.

După acest milestone, implementează un vertical slice cu un provider real și compară rezultatele pe un corpus mic de test înainte de a extinde toate instrumentele.
