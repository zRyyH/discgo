# DISCGO — Plano de arquitetura e execução (v2)

> Documento-mestre para implementação. Escrito para ser executado por agentes (Claude Opus 5.5) com supervisão humana.
> Idioma do documento: português. Código, identificadores, nomes de arquivo e mensagens de commit: inglês.

## 0. Como usar este plano (agente executor: leia primeiro)

- Este arquivo é a fonte da verdade para arquitetura, tecnologia e protocolo. Não troque tecnologia, biblioteca principal ou formato de protocolo sem registrar a mudança na seção 13.
- Execute as fases da seção 10 em ordem. Cada fase tem critérios de aceite; só avance quando todos passarem. A fase 1 é um spike de risco e pode mudar decisões das seções 6 e 7; se mudar, registre na seção 13 antes de seguir.
- Versões: use a última versão estável no momento da execução. Referência em out/2026: Tauri 2.x, GStreamer 1.26+ (MSVC x64) com gst-plugins-rs, Go 1.26+, Node 24 LTS, LiveKit server 1.13+, PostgreSQL 17/18, Rust stable.
- Complexidade só é bem-vinda em dois lugares: o engine de captura (seção 6) e o transporte P2P/SFU (seções 3.2 e 7.4). Em todo o resto, prefira o comportamento padrão das bibliotecas.
- Não adicione funcionalidades fora do escopo (seção 1.2). Ideias vão para o Backlog (seção 11).
- Convenções: JSON em `snake_case`; ids UUIDv7 em texto; timestamps RFC 3339 em UTC; erros HTTP em JSON `{"error":{"code":"...","message":"..."}}`; logs estruturados.

### 0.1 O que mudou em relação à v1
- **Shell do app: Electron → Tauri 2 (WebView2).** A v1 escolheu Electron por causa do `desktopCapturer`. Com a captura de tela saindo do navegador para um engine nativo, essa vantagem some e o Tauri entrega metade da memória e um décimo do instalador.
- **Captura de tela em engine nativo** (Rust + GStreamer): Windows Graphics Capture → textura D3D11 → conversão na GPU → encoder de hardware (NVENC/AMF/QSV/Media Foundation) → WebRTC, sem a textura passar pela CPU. É o mesmo desenho do OBS e do Go Live do Discord.
- **Transporte P2P primeiro.** Com 2 pessoas no canal de voz, mídia direta entre os dois sem servidor. Com 3 ou mais, ou se o P2P não conectar, SFU (LiveKit) em São Paulo. A regra é do servidor e a troca é automática.
- **Orçamentos de performance** medíveis (seção 1.3) e **direção visual** explícita (seção 8).
- Fases reordenadas: o engine é validado antes de qualquer tela.

## 1. Objetivo e escopo

### 1.1 O que é
Aplicativo desktop (Windows 10 20H1+ x64) estilo Discord para uma comunidade (um único "servidor"), com:
- Canais de texto: mensagens com anexos (imagens e arquivos), editar e apagar as próprias mensagens, histórico paginado.
- Canais de voz: entrar/sair, mutar microfone, ensurdecer (deafen), escolha de dispositivos, indicador de quem está falando, volume por usuário.
- Dentro do canal de voz: compartilhar tela (monitor ou janela, com áudio do sistema opcional) e webcam. Vários usuários podem compartilhar ao mesmo tempo.
- Login com Google. Entrada na comunidade por convite. Papéis: `admin` e `member`. Admin cria/edita/apaga canais e convites.
- Presença online/offline e lista de quem está em cada canal de voz, visível para todos.

### 1.2 Fora do escopo (v1)
DMs, múltiplos servidores/guilds, permissões por canal, reações/threads/pins/busca, markdown completo, push-to-talk, notificações, criptografia ponta a ponta, mobile/macOS/Linux, gravação, bots/API pública, tema claro.

### 1.3 Orçamentos de performance (medidos, não estimados)
Máquina de referência "fraca": notebook com 2 núcleos físicos, 8 GB de RAM, iGPU Intel/AMD com encoder de hardware, Windows 10/11.

| Situação | Orçamento |
|---|---|
| App ocioso (sem chamada) | RSS total ≤ 120 MB (shell + WebView2 + engine parado); CPU ≤ 0,5 %; zero timers acima de 1 Hz |
| Chamada de voz, sem vídeo | CPU ≤ 3 %; RSS ≤ 180 MB |
| Compartilhando 1080p60 | CPU do engine ≤ 5 %; zero cópia GPU→CPU por frame; encoder de hardware em uso |
| Compartilhando 1440p60 | CPU do engine ≤ 6 %; frames entregues ≥ 58/s em máquina de referência com link suficiente |
| Assistindo 1080p60 | CPU ≤ 6 % (decodificação por hardware, render pelo compositor) |
| Instalador | ≤ 90 MB (shell + engine + runtime GStreamer recortado) |
| Início do app | janela visível em ≤ 1 s; engine aquecido em segundo plano ao entrar em canal de voz |

Latência-alvo (vidro-a-vidro para tela, boca-ouvido para voz), medidas no overlay de debug:

| Caminho | Voz | Tela 60 fps |
|---|---|---|
| P2P, ambos no Brasil | ≤ 60 ms | ≤ 80 ms |
| SFU em São Paulo, ambos no Brasil | ≤ 80 ms | ≤ 100 ms |

### 1.4 De onde vem a latência (para calibrar expectativas)
| Etapa | Custo típico | Quem controla |
|---|---|---|
| Captura (espera pelo próximo frame) | 0 a 16 ms a 60 fps | WGC |
| Codificação por hardware | 2 a 5 ms | encoder |
| Rede | 5 a 40 ms dentro do Brasil | operadoras |
| Desvio pelo SFU | +1 a 10 ms em relação ao P2P | nós |
| Jitter buffer do receptor | 0 a 30 ms | nós (`jitterBufferTarget`) |
| Decodificação + apresentação | 3 a 20 ms | GPU e compositor |

O P2P economiza apenas a linha "desvio pelo SFU". Os ganhos grandes estão em captura sem cópia, encoder de hardware, GOP sem B-frames e jitter buffer baixo, e esses valem para os dois caminhos.

## 2. Decisões de tecnologia (travadas)

| Camada | Escolha | Por quê |
|---|---|---|
| Shell do app | **Tauri 2** (Rust + WebView2) com **React + TypeScript + Tailwind** | WebView2 é Chromium compartilhado com o Edge: mesma pilha de áudio (AEC3, Opus) e de decodificação por hardware, com ~metade da memória do Electron e sem embutir um Chromium. Rust já é necessário pelo engine. |
| Engine de captura | **Rust + GStreamer** (plugins `d3d11`, `nvcodec`, `amfcodec`, `qsv`, `mediafoundation`, `wasapi2`, `webrtc`, gst-plugins-rs `webrtcsink`/`livekitwebrtcsink`) como sidecar | Único toolkit maduro com captura WGC/DXGI em memória D3D11, conversão na GPU, encoders de hardware dos três fabricantes com entrada D3D11 (zero-copy) e um sink WebRTC completo com controle de congestionamento e signaller LiveKit prontos. Processo separado isola crashes de driver. |
| Voz e webcam | WebRTC do WebView2 (`getUserMedia` + `RTCPeerConnection` / `livekit-client`) | Melhor cancelamento de eco disponível e integração direta com a UI. |
| SFU | **LiveKit** self-hosted (Docker, Go) | Para 3+ participantes e como fallback do P2P. Encode uma vez, distribui para N. |
| P2P | `RTCPeerConnection` no WebView (voz/cam) e `webrtcsink` no engine (tela), sinalização pelo gateway próprio, STUN próprio, sem TURN | Com 2 participantes não há servidor no caminho da mídia. Se o P2P precisaria de relay, usa-se o SFU, que já é nosso servidor e faz mais. |
| Backend (API + gateway) | **Go**: `net/http`, `coder/websocket`, `pgx` + `sqlc`, `go-oidc`, `aws-sdk-go-v2`, `livekit/protocol`, `livekit/server-sdk-go` | Binário único, imagem de ~20 MB, SDK do LiveKit nativo. Também relaciona sinalização P2P e decide o modo da sala. |
| Banco | **PostgreSQL** 17+ (container) | Padrão. |
| Arquivos | **AWS S3** (sa-east-1): anexos privados com URLs pré-assinadas; releases públicos | Upload direto cliente→S3. |
| Proxy / TLS | **nginx** (rede host) + certbot | Termina TLS da API e da sinalização do LiveKit. Mídia não passa por ele. |
| Hospedagem | 1 VM Magalu Cloud (BR-SE1), Ubuntu 24.04, Docker Compose | Tudo em containers. |
| Login | **Google OAuth 2.0** (code flow no servidor) + deep link `discgo://` + sessão opaca própria | Google bloqueia login em webviews; o fluxo nativo correto é navegador do sistema + deep link. |
| Distribuição | Tauri bundler (NSIS) + `tauri-plugin-updater` (JSON estático + instalador no S3, artefatos assinados com minisign) | Instalador padrão e auto-update sem servidor extra. |

### 2.1 Por que Tauri agora, e o que faria voltar para Electron
Vantagens que pesaram: memória, tamanho, Rust já no projeto, sidecar nativo via `tauri-plugin-shell`. Riscos conhecidos do WebView2 e como são tratados:
- Pedido de permissão de microfone/câmera a cada sessão → tratar `PermissionRequested` via `webview2-com` no `setup` do Tauri e permitir mic/câmera para a origem do app.
- Throttling com a janela minimizada → `additional_browser_args` com `--disable-background-timer-throttling --disable-renderer-backgrounding` (reinserindo os args padrão do Tauri).
- Versão do Chromium controlada pelo Windows Update → testar a cada release do Edge estável; o código WebRTC usado é padrão e estável.
A fase 1 valida esses três pontos. Se algum não puder ser resolvido, o shell volta a ser Electron: a UI React e o engine não mudam, só a cola do shell (seção 7.2), que deve ficar fina por isso.

### 2.2 Por que P2P só com 2 participantes
- Em malha (mesh), quem compartilha tela envia uma cópia por espectador: 8 Mbps × 4 espectadores = 32 Mbps de upload, acima de muitos planos domésticos. No WebView, cada `RTCPeerConnection` também codifica separadamente, multiplicando o custo de CPU/GPU. Com o SFU, uma cópia sobe e o servidor distribui.
- Voz em malha funciona até 5 ou 6 pessoas, mas manter dois topologias para voz e tela na mesma sala dobra os estados de erro.
- Com 2 pessoas o P2P é puro ganho: sem servidor no caminho, sem custo de banda nossa, e a tela tem exatamente um espectador.
Regra: 2 participantes → P2P; 3+ → SFU; P2P que não conecta em 8 s ou cai → SFU, com o par marcado por 1 h. Volta ao P2P só após 10 s estáveis com 2 participantes (histerese). O limite é configurável no servidor (`P2P_MAX_PARTICIPANTS`, padrão 2) para experimentos futuros.

### 2.3 Alternativas consideradas e descartadas
- **Captura pelo Chromium (`getDisplayMedia`)**: o libwebrtc copia cada frame da GPU para a CPU, converte BGRA→I420 na CPU e sobe de novo para o encoder. Em 1080p60 é um custo tolerável; em 1440p60 e 4K em máquina fraca, não. Fica como fallback de emergência apenas se o engine falhar totalmente (seção 6.9).
- **LiveKit Rust SDK no engine**: não aceita frames já codificados e não tem encoder de hardware no Windows. Viraria codificação por software.
- **Pipeline próprio sem GStreamer** (`windows-capture` + Media Foundation + `str0m`): zero-copy possível, mas obrigaria a escrever packetização, NACK, controle de congestionamento e a sinalização do LiveKit à mão. Semanas de trabalho que o GStreamer já entrega.
- **Sunshine/Moonlight embutidos**: latência excelente, mas são 1:1, com protocolo próprio e sem integração com salas.
- **Cliente nativo em Rust/C#/C++ com UI nativa**: UI "tão bonita quanto o Discord" é muito mais lenta de fazer sem HTML/CSS.
- **Electron** (v1): descartado pelos motivos da seção 2.1; permanece como plano B do shell.
- **Mesh P2P para todos**: seção 2.2.
- **Node/.NET no backend, mediasoup/Janus como SFU, LiveKit Cloud**: mesmos motivos da v1 (mais peso ou menos integração).

## 3. Arquitetura

```
┌──────────────────────────────── Windows ─────────────────────────────────────┐
│ discgo.exe (Tauri, Rust)            discgo-engine.exe (Rust + GStreamer)      │
│  ├─ janela, deep link, keyring,      ├─ WGC/DXGI → D3D11 → convert (GPU)      │
│  │  updater, sidecar, permissões     │   → encoder HW (zero-copy) → webrtcsink │
│  └─ WebView2 (React)                 ├─ wasapi2src loopback → opus (áudio sys) │
│      ├─ REST + Gateway WS            └─ stdio JSON ⇄ shell                     │
│      ├─ voz/cam: RTCPeerConnection (P2P) ou livekit-client (SFU)              │
│      └─ recepção de vídeo: <video> com decode HW                               │
└──────┬───────────────────┬──────────────────┬───────────────────┬────────────┘
       │ HTTPS             │ WSS /gateway     │ P2P: UDP direto   │ SFU: WSS + UDP
       │                   │ (+ sinalização   │ entre os 2 clientes│
       ▼                   ▼  P2P relayed)    ▼                   ▼
┌──────────────────── VM Magalu Cloud BR-SE1 (Docker Compose) ──────────────────┐
│ nginx (host): api.DOMAIN → :8080 | lk.DOMAIN → :7880                           │
│ api (Go): auth, canais, mensagens, presença, voice state, modo P2P/SFU,        │
│           relay de SDP/ICE, tokens LiveKit, presign S3                         │
│ livekit (host): SFU 7881/tcp 7882/udp; STUN/TURN 3478/udp 5349/tcp;            │
│                 webhooks → api                                                 │
│ postgres | backup → S3                                                         │
└────────────────────────────────────────────────────────────────────────────────┘
       │ PUT/GET pré-assinados                              ▲ OAuth code flow
       ▼                                                    │
  AWS S3 sa-east-1                                   accounts.google.com
```

Princípios: a API nunca vê bytes de mídia nem de arquivos. O engine nunca vê a UI: só recebe comandos e devolve eventos. O WebView nunca captura tela.

### 3.1 Fluxos
1. **Login**: shell abre o navegador do sistema em `GET /v1/auth/google/start` → Google → `GET /v1/auth/google/callback` (API valida `id_token`, upsert do usuário, código one-time de 60 s) → 302 `discgo://auth?code=...` → `tauri-plugin-deep-link` entrega ao shell → `POST /v1/auth/exchange` → sessão (token opaco, 30 dias) no Gerenciador de Credenciais do Windows via `keyring`.
2. **Boot**: WebView conecta `WSS /v1/gateway`, envia `identify` (token + capacidades do cliente) → recebe `ready` → UI renderiza. Toda reconexão repete `ready` (resync completo).
3. **Texto**: `POST /v1/channels/{id}/messages` → API grava e faz broadcast de `message_create`.
4. **Entrar em voz**: cliente envia `voice_join {channel_id}` pelo gateway → API registra o voice state, calcula o modo da sala (seção 3.2) e responde com `voice_session {session_id, mode, ...}`; todos recebem `voice_state_update`.
   - `mode = p2p`: os dois clientes abrem um `RTCPeerConnection` (voz + cam) e negociam via `rtc_signal` relayed pelo gateway. STUN de `GET /v1/rtc/ice-servers`.
   - `mode = sfu`: `GET /v1/channels/{id}/voice-token` → `livekit-client` conecta em `wss://lk.DOMAIN`.
5. **Compartilhar tela**: UI pede fontes ao engine (`list_sources`), usuário escolhe, UI manda `start` ao engine com o alvo:
   - P2P: engine cria um `webrtcsink` com signaller custom; SDP/ICE trafegam engine → shell → gateway → espectador, que abre um `RTCPeerConnection` só de recepção.
   - SFU: engine recebe um token LiveKit de identidade `{user_id}#screen` (`voice-token?kind=screen`) e publica com `livekitwebrtcsink`; a UI agrupa esse participante sob o usuário dono.
6. **Troca de modo**: quando a contagem cruza o limite, a API emite `voice_session` novo para todos no canal; cada cliente derruba a sessão atual (inclusive o engine) e sobe a nova. A UI mostra "reconectando" por até 2 s.
7. **Upload**: `POST /v1/uploads/presign` → `PUT` direto no S3 → mensagem com `attachments[{key,…}]` → API devolve mensagens com `url` de GET pré-assinada (7 dias).

### 3.2 Regra de modo (autoridade do servidor)
```
onVoiceChange(channel):
  n = participantes(channel)
  desired = (n == 2 && ambos p2p_capable && par não bloqueado) ? p2p : sfu
  if desired == current: return
  if desired == p2p: agendar troca em 10 s; cancelar se n mudar
  else: trocar agora
  trocar: session_id = uuidv7(); broadcast voice_session para o canal
cliente: p2p_failed {session_id} → bloquear par por 1 h → trocar para sfu
```
Estado em memória na API (processo único). Com `n == 1` o modo é `sfu` ocioso: o cliente não conecta a nada até alguém entrar.

## 4. Estrutura do repositório

```
discgo/
  PLAN.md
  README.md                       # como rodar em dev
  Makefile                        # infra-up, api, engine, desktop, build, lint, test
  Cargo.toml                      # workspace: desktop/src-tauri, engine
  api/                            # Go
    cmd/api/main.go
    internal/
      config/  db/  auth/  httpapi/  gateway/  voice/  livekit/  storage/  protocol/
    migrations/0001_init.sql  queries/*.sql  sqlc.yaml  Dockerfile
  engine/                         # Rust + GStreamer (sidecar)
    Cargo.toml
    src/
      main.rs                     # loop stdio JSON
      protocol.rs                 # comandos e eventos (espelho de desktop/src/shared/engine.ts)
      sources.rs                  # enumeração de monitores/janelas + miniaturas
      encoder.rs                  # detecção e seleção de encoder por adapter
      pipeline.rs                 # montagem do pipeline, presets, update ao vivo
      signaller_gateway.rs        # Signallable custom para P2P
      stats.rs                    # fps, bitrate, encode time, zero-copy flag
    gst-runtime/                  # lista de DLLs/plugins a empacotar + script de cópia
  desktop/
    package.json  vite.config.ts  tailwind.config.ts  DESIGN.md
    src-tauri/                    # shell Rust
      tauri.conf.json  Cargo.toml  capabilities/
      src/ main.rs  deeplink.rs  webview.rs (permissões, args)  engine.rs (sidecar)  secrets.rs (keyring)  power.rs
      binaries/                   # discgo-engine-x86_64-pc-windows-msvc.exe (gerado)
      resources/gst/              # runtime GStreamer recortado (gerado)
    src/
      shared/ protocol.ts  engine.ts
      api/    rest.ts  gateway.ts
      stores/ auth  channels  messages  presence  voice  settings
      media/  MediaSession.ts  P2pSession.ts  SfuSession.ts  ScreenShare.ts  devices.ts  stats.ts
      components/ Titlebar Sidebar ChannelList MemberList Chat MessageList Composer
                  VoiceBar MediaStage StreamTile SourcePicker Settings Login Invite DebugOverlay
      App.tsx  main.tsx
  deploy/
    docker-compose.dev.yml  docker-compose.prod.yml
    nginx/  livekit/livekit.yaml.example  .env.example  scripts/
```

## 5. Backend (api/) — Go

Tudo da v1 permanece (bibliotecas, modelo de dados, REST de auth/convites/canais/mensagens/uploads, gateway, uploads, Dockerfile). O que muda:

### 5.1 Modelo de dados
Sem alteração. Tabelas `users`, `sessions`, `invites`, `channels`, `messages` como na v1 (UUIDv7, `attachments jsonb`, índice `(channel_id, id desc)`).

### 5.2 REST adicionado
| Método | Rota | Descrição |
|---|---|---|
| GET | /rtc/ice-servers | `{ice_servers:[{urls:["stun:turn.DOMAIN:3478","stun:stun.l.google.com:19302"]}]}` |
| GET | /channels/{id}/voice-token?kind=user\|screen | token LiveKit; `screen` → identidade `{user_id}#screen`, `CanSubscribe:false`, metadata `{"owner":user_id}` |

### 5.3 Gateway: ops adicionados
Cliente → servidor:
- `identify` `{token, client:{version, p2p:true}}`
- `voice_join` `{channel_id}` / `voice_leave` `{}`
- `voice_state` `{self_mute, self_deaf}`
- `rtc_signal` `{session_id, to_user_id, stream:"av"|"screen", type:"offer"|"answer"|"ice", payload}`
- `p2p_failed` `{session_id, reason}`

Servidor → cliente:
- `voice_session` `{channel_id, session_id, mode:"p2p"|"sfu", peer_user_id?, livekit_url?}` (para quem está no canal)
- `rtc_signal` (relay, mesmo corpo + `from_user_id`)
- demais eventos da v1 (`ready`, `message_*`, `channel_*`, `member_*`, `presence_update`, `voice_state_update`)

Voice state vem agora do `voice_join`/`voice_leave`, com os webhooks do LiveKit como confirmação secundária (um `participant_left` sem `voice_leave` em 10 s remove o usuário). O pacote `internal/voice` guarda `channel → {participants, mode, session_id, timer}` e o bloqueio de pares.

### 5.4 Configuração (env) adicionada
`P2P_MAX_PARTICIPANTS=2`, `P2P_SWITCH_DELAY=10s`, `P2P_BLOCK_TTL=1h`, `STUN_URLS`.

## 6. Engine de captura (engine/) — Rust + GStreamer

Aqui está o trabalho de otimização profunda. O objetivo é que o frame capturado nunca saia da GPU até virar pacote RTP.

### 6.1 Pipeline alvo (SFU e P2P)
```
d3d11screencapturesrc (capture-api=wgc, cursor, sem borda)
  ! video/x-raw(memory:D3D11Memory),framerate=60/1
  ! d3d11convert                      # BGRA → NV12 e escala, na GPU
  ! video/x-raw(memory:D3D11Memory),format=NV12,width=W,height=H
  ! [encoder HW com entrada D3D11]    # ver 6.2; configurado via encoder-setup
  ! webrtcsink / livekitwebrtcsink    # CC (GCC), NACK, pacing, sinalização
wasapi2src loopback=true ! audioconvert ! audioresample ! opusenc  ! mesmo sink (opcional)
```
Decidido na fase 1: **modo B** (ver seção 13, 2026-10-29 fase 1). Os dois modos avaliados:
- **A (preferido)**: entregar vídeo cru em memória D3D11 ao `webrtcsink` e deixar que ele instancie o encoder. Ganha controle de congestionamento que ajusta o bitrate do encoder ao vivo. Exige confirmar que o conversor interno escolhido é `d3d11convert` e que a cadeia permanece em `memory:D3D11Memory` até o encoder.
- **B (fallback)**: codificar antes (`... ! encoder ! h264parse ! webrtcsink`) com bitrate fixo do preset, respondendo a PLI/FIR (o sink converte em `GstForceKeyUnit`). Em P2P, acrescentar `rtpgccbwe` e ajustar a propriedade `bitrate` do encoder a partir de `estimated-bitrate` (laço de ~100 linhas).

### 6.2 Seleção de encoder e adapter
Ordem de preferência, sempre **no mesmo adapter que gerou a textura** (notebooks híbridos: o monitor costuma pertencer à iGPU; um encoder na dGPU exigiria cópia entre adapters e quebra o zero-copy):
1. NVIDIA: `nvd3d11h264enc` (`nvd3d11av1enc` se AV1)
2. AMD: `amfh264enc` (`amfav1enc`)
3. Intel: `qsvh264enc` (`qsvav1enc`)
4. Qualquer MFT de hardware: `mfh264enc`
5. Software: `x264enc preset=ultrafast tune=zerolatency` (aviso na UI: "codificação por software")
Detecção no boot do engine: `ElementFactory::find` + pipeline de prova de 1 frame por candidato (`fakesink`), com timeout de 2 s. Resultado cacheado em `%LOCALAPPDATA%/discgo/engine-probe.json` com a assinatura do driver. Reexecutado se o driver ou a GPU mudar.

### 6.3 Parâmetros de baixa latência (aplicados no `encoder-setup`)
| Encoder | Propriedades |
|---|---|
| nvd3d11h264enc | `preset=p1..p3`, `tune=ultra-low-latency`, `rc-mode=cbr`, `zerolatency=true`, `bframes=0`, `gop-size=120`, `repeat-sequence-header=true` |
| amfh264enc | `usage=ultra-low-latency`, `rate-control=cbr`, `gop-size=120`, sem B-frames |
| qsvh264enc | `target-usage=7`, `low-latency=true`, `rate-control=cbr`, `gop-size=120`, `bframes=0` |
| mfh264enc | `low-latency=true`, `rc-mode=cbr`, `gop-size=120`, `max-bframes=0`, `quality-vs-speed=0..30` |
| x264enc | `speed-preset=ultrafast`, `tune=zerolatency`, `key-int-max=120`, `bframes=0` |
Comum: `bitrate` do preset em kbit/s; keyframe sob demanda via `GstForceKeyUnit`; `videorate drop-only=true` antes do encoder quando a fonte entrega acima do fps do preset; `h264parse config-interval=-1`. Nomes de propriedades variam entre versões: confirmar com `gst-inspect-1.0` e manter a tabela real em `engine/src/encoder.rs`.

Modo de conteúdo escolhido pelo usuário:
- **Texto/nitidez**: resolução fixa; sob congestionamento o CC baixa bitrate e, abaixo de 40 % do alvo, o engine reduz fps (60 → 30 → 15) antes de reduzir resolução.
- **Movimento/fluidez**: fps fixo; sob congestionamento reduz resolução por `d3d11convert` (1440p → 1080p → 720p) e mantém 60 fps.

### 6.4 Presets
| Preset | Resolução | FPS | Bitrate |
|---|---|---|---|
| 720p30 | 1280×720 | 30 | 3 Mbps |
| 1080p30 | 1920×1080 | 30 | 5 Mbps |
| 1080p60 (padrão) | 1920×1080 | 60 | 8 Mbps |
| 1440p60 | 2560×1440 | 60 | 12 Mbps |
| Nativa 60 | da fonte | 60 | 16 Mbps |
Codec: H.264 padrão (decodificação por hardware em qualquer máquina); AV1 opcional quando engine e espectadores suportam (negociado no SDP; em SFU, só se todos os espectadores atuais decodificam AV1 por hardware, caso contrário H.264).

### 6.5 Transporte no engine
- **SFU**: `livekitwebrtcsink` com `signaller::ws-url`, `signaller::auth-token` (token de `voice-token?kind=screen`), `signaller::room-name = channel_id`. Um stream de vídeo e, opcionalmente, um de áudio.
- **P2P**: `webrtcsink` com signaller custom (`engine/src/signaller_gateway.rs`, implementa `Signallable` do crate `gst-plugin-webrtc`), que converte os eventos de SDP/ICE em mensagens stdio para o shell e vice-versa. Um único consumidor (o par). `congestion-control=gcc`, `min-bitrate`/`max-bitrate` do preset, `stun-server` igual ao da UI, `turn-server` vazio.
- Linkar o crate `gst-plugin-webrtc` (features `livekit`) estaticamente no engine; o `rswebrtc` não precisa ser distribuído como DLL.
- Simulcast de tela não está disponível no `webrtcsink`; em SFU sobe uma camada. Mitigação no Backlog (segunda camada baixa via segundo encoder).

### 6.6 Áudio do sistema
`wasapi2src loopback=true low-latency=true` (modo include/exclude de processo quando disponível, para não capturar o próprio app) → `audioconvert ! audioresample ! opusenc bitrate=128000 frame-size=20 audio-type=generic` → stream de áudio do mesmo sink. Só oferecido para captura de monitor; em captura de janela, o Windows não dá loopback por janela de forma confiável.

### 6.7 Fontes e miniaturas
- Monitores: `EnumDisplayMonitors` (crate `windows`): handle, nome, resolução, posição, adapter.
- Janelas: `EnumWindows` filtrando visíveis, com título, sem ferramentas/cloaked (`DwmGetWindowAttribute DWMWA_CLOAKED`).
- Miniaturas: pipeline curto `d3d11screencapturesrc num-buffers=1 ! d3d11convert ! d3d11download ! pngenc` em 320 px de largura, cache de 2 s. É a única cópia GPU→CPU do engine e acontece só no seletor.

### 6.8 Protocolo engine ⇄ shell (JSON por linha em stdin/stdout)
Comandos: `probe`, `list_sources`, `start {target:{kind:"livekit",url,token}|{kind:"p2p",session_id}, source:{kind:"monitor"|"window", id}, preset, codec, content_mode, system_audio}`, `update {preset?, content_mode?}`, `sdp {session_id, type, sdp}`, `ice {session_id, candidate, sdp_mid, sdp_m_line_index}`, `stop`, `shutdown`.
Eventos: `ready {gst_version, encoders:[{name, vendor, adapter}], warnings}`, `sources {…}`, `started {encoder, adapter, zero_copy:bool, codec}`, `sdp`, `ice`, `stats {fps_captured, fps_encoded, bitrate_kbps, encode_ms_p50, encode_ms_p99, dropped, rtt_ms?, loss?}` a cada 1 s, `stopped`, `error {code, message, fatal}`.
Logs em stderr. O shell reinicia o engine se o processo morrer durante um compartilhamento e reenvia `start`.

### 6.9 Verificação de zero-copy e fallbacks
- No `started`, o engine inspeciona os caps negociados em cada pad da cadeia de vídeo; `zero_copy=true` só se todos entre a fonte e o encoder forem `memory:D3D11Memory`. Em dev, `GST_DEBUG=GST_CAPS:5` confirma.
- Fallbacks em cascata: WGC indisponível → `capture-api=dxgi` (só monitores); encoder HW ausente no adapter da captura → encoder HW em outro adapter (com cópia, `zero_copy=false`) → `x264enc`; modo A do sink não fica em D3D11 → modo B; engine não inicia (DLL faltando, driver quebrado) → UI oferece `getDisplayMedia` do WebView2 em 720p30 como último recurso, se o WebView2 suportar; senão, tela indisponível com mensagem clara.
- Overlay de debug na UI (Ctrl+Shift+D) mostra tudo isso e as estatísticas do receptor (`getStats`): fps decodificado, jitter buffer, frames descartados, RTT.

### 6.10 Runtime GStreamer empacotado
- Fonte: instalador oficial GStreamer MSVC x64 (runtime + development para compilar). O script `engine/gst-runtime/collect.ps1` copia só o necessário para `desktop/src-tauri/resources/gst/`: `gstreamer-1.0`, `gstbase`, `gstvideo`, `gstaudio`, `gstrtp`, `gstwebrtc`, `gstsdp`, `gstd3d11`, dependências (glib, gio, orc, libnice, openssl, srtp, opus, x264), e os plugins: `coreelements`, `app`, `videoconvertscale`, `videorate`, `audioconvert`, `audioresample`, `opus`, `d3d11`, `mediafoundation`, `nvcodec`, `amfcodec`, `qsv`, `wasapi2`, `x264`, `rtp`, `rtpmanager`, `webrtc`, `nice`, `dtls`, `srtp`, `videoparsersbad`, `png`.
- As DLLs ficam no diretório do executável do engine (busca de DLL em tempo de carga). `GST_PLUGIN_PATH` e `GST_PLUGIN_SYSTEM_PATH` apontam para `resources/gst/plugins`; registro de plugins cacheado em `%LOCALAPPDATA%/discgo/gst-registry.bin`.
- Testar em máquina limpa (sem GStreamer instalado, sem Visual Studio) na fase 1 e na fase 8. Alvo: runtime ≤ 60 MB.

## 7. Shell e UI (desktop/) — Tauri 2 + React

### 7.1 Bibliotecas
- Rust (shell): `tauri` 2, `tauri-plugin-shell` (sidecar), `tauri-plugin-deep-link`, `tauri-plugin-single-instance`, `tauri-plugin-updater`, `tauri-plugin-opener`, `tauri-plugin-store` (settings), `tauri-plugin-window-state`, `keyring` (token de sessão no Credential Manager), `webview2-com` + `windows` (permissões de mídia, `SetThreadExecutionState`).
- Web: `react`, `react-dom`, `typescript`, `vite`, `tailwindcss`, `zustand`, `livekit-client`, `@radix-ui/react-*` (dropdown, dialog, tooltip, slider, switch, context-menu; sem estilo), `lucide-react`, `motion` (só `transform`/`opacity`), `@tanstack/react-virtual` (lista de mensagens). Fontes Inter e JetBrains Mono empacotadas localmente. Sem UI kit.

### 7.2 Shell Rust (manter fino: é a parte trocável)
- Janela: `decorations: false`, `shadow: true`, titlebar própria com região de arraste e botões; tamanho mínimo 960×600; `window-state` restaura posição.
- WebView2: no `setup`, `with_webview` → `ICoreWebView2::add_PermissionRequested` permitindo microfone e câmera para a origem do app; `additional_browser_args` = args padrão do Tauri + `--disable-background-timer-throttling --disable-renderer-backgrounding --autoplay-policy=no-user-gesture-required`.
- Deep link `discgo://` + instância única; em dev, registrar o scheme para o binário de debug.
- Sidecar: `Command::sidecar("discgo-engine")`, stdout por linha → eventos Tauri `engine://event`; comandos `engine_send`. Inicia ao entrar em canal de voz (aquecimento), encerra 60 s após sair.
- `secrets.rs`: `session_get/set/clear` via `keyring`. `power.rs`: `ES_DISPLAY_REQUIRED` enquanto compartilha tela.
- Comandos expostos à UI: `open_external`, `session_*`, `settings_*`, `engine_send`, `app_version`, `window_*` (min/max/close).

### 7.3 Arquitetura da UI
Stores Zustand alimentadas por `ready` + eventos; REST só para ações e paginação. Camada de mídia atrás de uma interface única:
```ts
interface MediaSession {
  readonly mode: 'p2p' | 'sfu';
  connect(): Promise<void>; close(): Promise<void>;
  setMicEnabled(on: boolean): Promise<void>;
  setCameraEnabled(on: boolean): Promise<void>;
  setDeafened(on: boolean): void;
  setUserVolume(userId: string, v: number): void;
  screenTarget(): EngineTarget;                  // {kind:'livekit',url,token} | {kind:'p2p',session_id}
  onTrack(cb: (t: RemoteTrack) => void): void;   // {userId, kind:'mic'|'cam'|'screen'|'screen_audio', track}
  onSpeaking(cb: (ids: string[]) => void): void;
}
```
`SfuSession` envolve `livekit-client`; `P2pSession` envolve um `RTCPeerConnection` bidirecional (mic + cam) e um `RTCPeerConnection` só de recepção para a tela do par; `ScreenShare.ts` fala com o engine e, em P2P, faz a ponte de SDP/ICE entre engine e gateway. `voice.ts` reage a `voice_session`: fecha a sessão atual, cria a nova, reaplica mute/deaf/cam/tela.

### 7.4 Voz e webcam no WebView
- Captura: `getUserMedia({audio:{echoCancellation:true, noiseSuppression:true, autoGainControl:true, channelCount:1, sampleRate:48000}})`; webcam 1280×720@30.
- P2P: negociação "perfeita" (polite = menor `user_id`), `bundlePolicy:'max-bundle'`, `iceServers` do endpoint, `iceTransportPolicy:'all'` mas sem TURN configurado. Opus via SDP: `maxaveragebitrate=64000` (96000 em "alta qualidade"), `useinbandfec=1`, `usedtx=1`, `stereo=0`, `ptime=20`. Preferir `audio/red` em `setCodecPreferences`. Cam em H.264 (hardware) com `maxBitrate` 1,5 Mbps. Falha: `iceConnectionState` `failed`, ou `disconnected` por mais de 5 s, ou sem `connected` em 8 s → `p2p_failed`.
- SFU: `new Room({adaptiveStream:true, dynacast:true, audioCaptureDefaults:{…}, publishDefaults:{dtx:true, red:true, audioPreset:{maxBitrate:64_000}, simulcast:true, videoCodec:'h264'}, videoCaptureDefaults:{resolution: VideoPresets.h720.resolution}})`.
- Comum: falando via nível de áudio (LiveKit `ActiveSpeakersChanged`; em P2P, `getStats` `audioLevel` a 10 Hz só enquanto em chamada); volume por usuário em elemento `<audio>`; dispositivos via `enumerateDevices` + `setSinkId`; deafen = silenciar todos os `<audio>` + mute.

### 7.5 Recepção de vídeo
- `<video autoplay playsinline muted>` por stream, decodificação por hardware do Chromium, composição pela GPU; nunca desenhar frames em canvas.
- `RTCRtpReceiver.jitterBufferTarget = 0` para telas (P2P: direto; SFU: via `RemoteTrack.receiver` no `livekit-client`) e 20 ms para webcam.
- Só anexar tracks visíveis; tiles fora de tela desanexam (em SFU, `adaptiveStream` já pausa).

### 7.6 Regras de leveza da UI
- Sem `backdrop-filter`, sem sombras grandes animadas, sem gradientes animados, sem vídeo de fundo.
- Animações apenas em `transform` e `opacity`, 120 a 180 ms; `prefers-reduced-motion` respeitado.
- Nada em polling; `setInterval` apenas para stats da chamada (1 Hz) e só com o overlay aberto ou em chamada.
- Lista de mensagens virtualizada; imagens com `loading="lazy"` e dimensões conhecidas; avatares em 64 px cacheados.
- Re-render contido por seletores Zustand; mensagens memoizadas por id.
- Medição na fase 4: Performance panel do Edge DevTools (`edge://inspect` via `devtools` do Tauri) com orçamento de ≤ 2 ms de scripting por frame em scroll.

## 8. Direção visual

Referência: Discord na organização, Linear/Arc na sobriedade. Tema escuro único. Tudo em `desktop/DESIGN.md` e no tema do Tailwind.

**Tokens**
- Superfícies: `bg-0 #0B0C10` (fundo da janela), `bg-1 #111218` (sidebar), `bg-2 #171923` (painéis e chat), `bg-3 #1E2130` (hover, inputs), `border #262A3A`.
- Texto: `text-1 #E7E9F0`, `text-2 #9BA1B5`, `text-3 #646B80`.
- Acento: `accent #8B9CFF` (um só). Estados: `ok #3DDC97` (online, falando), `danger #FF5C6C` (mute, sair), `warn #FFC857`.
- Tipografia: Inter 13 px corpo, 14 px mensagens, 12 px metadados, 15 px/600 títulos; JetBrains Mono para código. Line-height 1,45.
- Raios 6 / 10 / 14 px; grade de 4 px; sombras só em popovers (`0 8px 24px rgba(0,0,0,.45)`).
- Ícones Lucide 18 px, traço 1,75.

**Layout**
- Titlebar própria de 36 px com nome da comunidade, busca desativada (fora de escopo) e controles de janela.
- Sidebar 240 px: grupos "TEXTO" e "VOZ"; canais de voz expandem os participantes com avatar 20 px, ícones de mute/deaf, e anel verde de 2 px quando falando. Painel do usuário no rodapé (avatar, nome, mic, fones, engrenagem).
- Centro: chat com mensagens agrupadas por autor em 5 min, hover revela ações (editar, apagar, copiar); composer com borda sutil e foco em acento. Em voz com vídeo, o centro vira o `MediaStage`.
- Lista de membros 220 px, recolhível, online/offline.
- `MediaStage`: fundo `bg-0`, tiles 16:9 com raio 14 px, foco em um stream com filmstrip de 96 px; chip com nome e indicador de fps/qualidade; controles aparecem no hover e somem em 2 s; tela cheia com `F`.
- Barra de voz flutuante no rodapé do centro quando em chamada: canal, latência (P2P/SFU), mic, fones, câmera, tela, sair.
- Estados vazios com uma linha de texto e um ícone; skeletons em cinza `bg-3` sem animação de brilho.
- Sons curtos (entrar, sair, mute) em `.ogg` locais, volume 30 %, desativáveis.

## 9. Infra e deploy (deploy/)

Mantido da v1 (compose com nginx + certbot + livekit + api + postgres + backup; nginx e livekit em `network_mode: host`; `livekit.yaml` com `udp_port: 7882`, `use_external_ip: true`, TURN em 3478/udp e 5349/tcp; S3 com bucket privado de anexos e bucket público de releases; Google Cloud Console com dois redirect URIs). Alterações:
- O servidor TURN do LiveKit também responde STUN; `STUN_URLS` da API aponta para `stun:turn.DOMAIN:3478`. TURN continua existindo apenas para o caminho SFU.
- Releases: `latest.json` do `tauri-plugin-updater` + `discgo-setup.exe` assinados com minisign; chave privada só no CI (GitHub Actions, runner Windows).
- Security group inbound: 22/tcp restrito, 80/tcp, 443/tcp, 7881/tcp, 7882/udp, 3478/udp, 5349/tcp.
- Banda: só o caminho SFU consome banda da VM (upload do espectador × N). Em P2P a VM só relaciona sinalização.

## 10. Fases de execução

Cada fase termina com: código compilando e lint limpo, testes da fase passando, checklist manual executado, medições registradas em `docs/measurements.md`, commit.

### Fase 0 — Esqueleto
- Estrutura da seção 4, workspace Cargo, `Makefile`, `.gitignore`, `README.md`, `docker-compose.dev.yml` (Postgres + LiveKit `--dev`), `.env.example`.
- `api`: `/healthz`, config, pool, migration inicial. `desktop`: Tauri abrindo uma janela com React e titlebar própria. `engine`: binário que inicializa o GStreamer empacotado e responde `probe` com versão e encoders detectados.
- Aceite: os três sobem em dev; `probe` lista pelo menos um encoder de hardware na máquina de desenvolvimento; `collect.ps1` gera o runtime e o engine roda a partir dele em uma pasta isolada.

### Fase 1 — Spike do engine (de-risk; pode alterar as seções 6 e 7)
- `gst-launch-1.0` primeiro, Rust depois: captura WGC → D3D11 → encoder HW → `livekitwebrtcsink` na sala do LiveKit dev, assistida por uma página HTML mínima com `livekit-client`. Confirmar `zero_copy=true` e medir CPU em 1080p60 e 1440p60 com texto e com vídeo em movimento.
- Repetir com `webrtcsink` + signaller custom para uma página HTML com `RTCPeerConnection` (P2P). Medir latência vidro-a-vidro com um timer na tela filmado em 240 fps ou com relógio de alta resolução na página.
- Validar os três riscos do WebView2 (seção 2.1) em uma janela Tauri com `getUserMedia` e um `RTCPeerConnection` de loopback.
- Testar o runtime empacotado em máquina limpa.
- Aceite: 1080p60 com CPU do engine ≤ 5 % e 1440p60 ≤ 6 % na máquina de referência; latência P2P ≤ 80 ms em LAN; modo A ou B decidido e registrado; WebView2 aprovado ou decisão de voltar ao Electron registrada.

### Fase 2 — Auth e usuários
- Igual à v1 (Google, sessões, convites, primeiro admin), com deep link via `tauri-plugin-deep-link` e token no `keyring`.
- Aceite: login completo com duas contas; convite obrigatório para a segunda; sessão sobrevive a reinício.

### Fase 3 — Canais, mensagens e gateway
- CRUD de canais, mensagens, uploads; gateway com todos os ops das seções 5.3 e da v1; `internal/voice` com a regra de modo e o relay de `rtc_signal`; testes com `httptest`, cliente WS de teste e fixtures de contrato.
- Aceite: dois clientes recebem `message_create` em menos de 100 ms; `voice_session` muda de `p2p` para `sfu` ao entrar o terceiro e volta após 10 s quando sai; `p2p_failed` força `sfu`.

### Fase 4 — UI de texto e design system
- `DESIGN.md` e tema; titlebar, sidebar, chat virtualizado, composer, membros, uploads com progresso, settings básicas, estados vazios, sons.
- Aceite: orçamentos de "app ocioso" da seção 1.3 atingidos; scroll de 2 000 mensagens sem frame acima de 16 ms; revisão visual lado a lado com o Discord.

### Fase 5 — Voz e webcam (P2P e SFU)
- `MediaSession`, `P2pSession`, `SfuSession`, troca de modo, dispositivos, mute/deafen, falando, volume por usuário, webcam, barra de voz, overlay de debug.
- Aceite: 2 pessoas em P2P com latência ≤ 60 ms; terceira entra e todos migram para SFU em ≤ 2 s sem perder mute/cam; UDP bloqueado em um cliente → migra para SFU sozinho; janela minimizada 5 min sem degradação; orçamentos de "chamada de voz".

### Fase 6 — Compartilhamento de tela
- Integração engine ⇄ shell ⇄ sessões, `SourcePicker` com miniaturas, presets, modo de conteúdo, áudio do sistema, `MediaStage`, stats no overlay, fallbacks da seção 6.9, reinício automático do engine.
- Aceite: 1080p60 e 1440p60 legíveis com os orçamentos da seção 1.3; dois emissores simultâneos em SFU; emissor em P2P com um espectador; troca de modo durante um compartilhamento retoma a tela em ≤ 3 s; `zero_copy=true` em NVIDIA, AMD e Intel.

### Fase 7 — Produção
- Compose de produção, nginx + certbot, `livekit.yaml`, TURN/STUN, `deploy.sh`, backup, security group, DNS, buckets e IAM, redirect de produção no Google.
- Aceite: chamada P2P entre duas redes domésticas; SFU entre três; TURN forçado funciona no caminho SFU; backup no S3.

### Fase 8 — Distribuição
- Tauri bundler NSIS com bootstrapper do WebView2, engine como `externalBin`, runtime GStreamer em `resources`, updater com `latest.json` no S3, CI em tag `v*`, página HTML de fallback do login. Assinatura de código opcional (documentar).
- Aceite: instalar em máquina limpa, logar, entrar em voz, compartilhar tela, receber a atualização seguinte; instalador ≤ 90 MB.

## 11. Backlog (pós-v1)
Segunda camada baixa para tela em SFU (segundo encoder), AV1 por padrão quando o parque suportar, HEVC quando o WebRTC do Chromium habilitar recepção por padrão, mesh P2P de voz para 3 ou 4 pessoas se as medições justificarem, push-to-talk, notificações, não lidas, markdown básico, RNNoise, expulsar/banir, DMs, múltiplos servidores, Redis + vários nós LiveKit, tema claro, suporte a HDR na captura.

## 12. Riscos e mitigações
- `webrtcsink` quebrar o zero-copy ao inserir conversor em memória de sistema → modo B (pré-codificado) decidido na fase 1.
- `livekitwebrtcsink` com regressão em alguma versão → fixar a versão do gst-plugins-rs que passou no spike; plano C é publicar a tela via `livekit-client` do WebView com `getDisplayMedia` em preset baixo.
- Notebooks híbridos (iGPU + dGPU) → encoder escolhido no adapter da captura; se não houver, cópia entre adapters com aviso no overlay.
- Limite de sessões simultâneas do NVENC em GPUs de consumo → um único encoder por compartilhamento; miniaturas não usam encoder.
- WebView2: prompts de permissão, throttling, drift de versão → tratados na seção 2.1 e validados na fase 1; plano B é Electron com a mesma UI.
- Monitores HDR → captura em BGRA8 pode clipar cores; Backlog.
- P2P entre NATs simétricos → sem TURN por desenho; migra para SFU em até 8 s.
- Troca de modo durante a chamada gera 1 a 2 s de interrupção → histerese de 10 s e UI de "reconectando".
- Runtime GStreamer faltando DLL em máquina limpa → teste em VM limpa nas fases 1 e 8; lista de DLLs versionada.
- Repositório dentro do OneDrive → `node_modules` e `target/` sincronizados causam lentidão e corrupção; excluir as pastas da sincronização ou mover o repositório.

## 13. Registro de decisões
- 2026-10-29 (v1): Electron + React/TS, Go, PostgreSQL, LiveKit self-hosted, S3, nginx, Magalu Cloud BR-SE1. Login Google via navegador do sistema + deep link. Um único servidor/comunidade.
- 2026-10-29 (v2): shell Electron → Tauri 2; captura de tela em engine nativo Rust + GStreamer com zero-copy D3D11 e encoder de hardware; transporte P2P com 2 participantes e SFU com 3+ ou em falha, regra no servidor; orçamentos de performance e direção visual; fase 1 como spike de risco. Backend Go e LiveKit mantidos.
- 2026-10-29 (fase 0): versões usadas: GStreamer 1.28.8, Go 1.27, Rust 1.99, Node 24, Tauri 2.12, React 19, Vite 8, TypeScript 7, Tailwind 4, LiveKit 1.13.11, PostgreSQL 18. Tailwind 4 configura o tema em CSS (`@theme` em `desktop/src/styles.css`), então não há `tailwind.config.ts`. Migrations aplicadas por um runner embutido de ~50 linhas (`api/internal/db`), sem biblioteca. O runtime GStreamer empacotado inclui o MSVC CRT app-local (`vcruntime140*.dll`, `msvcp140.dll`), necessário em máquina limpa.
- 2026-10-29 (fase 1, spike do engine; números em `docs/measurements.md`):
  - **Modo B** (pré-codificado: `encoder ! h264parse ! webrtcsink`). O modo A não serve: o `webrtcsink` escolhe o encoder por rank (pega `nvh264enc`, CUDA, que não aceita D3D11) e só controla bitrate de uma lista fixa de encoders (`nvh264enc`, `qsvh264enc`, `x264enc`…), sem `nvd3d11h264enc`, `amfh264enc` nem `mfh264enc`. No modo B o GCC do `webrtcsink` (`rtpgccbwe` + TWCC) continua rodando e entrega a banda estimada pelo sinal `define-encoder-bitrates`; o engine aplica no encoder. Isso substitui o laço de ~100 linhas previsto em 6.1, em P2P e em SFU.
  - O estimador é ignorado quando ele *baixa* enquanto o stream está limitado pela aplicação (encoder produzindo < 65 % do bitrate aplicado, tela parada): sem isso a primeira cena em movimento depois de uma tela parada saía borrada.
  - `max-bitrate` do sink = 2,5 × bitrate do preset (o `rtpgccbwe` faz pacing exatamente na estimativa; com folga o frame sai mais rápido; o encoder continua limitado ao preset). Jitter buffer do receptor caiu de ~20 ms para ~11 ms.
  - `do-fec=false`: com FEC padrão o tráfego dobrava (16 Mbit/s para 8 Mbit/s de vídeo). NACK/RTX continuam.
  - Latência do pipeline forçada a 0 (`clocksync` interno do sink não segura frames já codificados). Sem diferença mensurável, mantido por ser o correto.
  - Um único `GstD3D11Device` por adapter durante a vida do engine (contexto `gst.d3d11.device.handle` compartilhado): o `d3d11screencapturesrc` em WGC não libera o device ao parar (+95 MB e +43 threads por sessão). Com o device compartilhado sobra +32 MB de memória privada por sessão; na fase 6 a troca P2P⇄SFU deve trocar só o sink, mantendo a captura, e o engine deve ser reciclado quando ocioso.
  - O plugin `rswebrtc` é linkado estaticamente (crate `gst-plugin-webrtc` 0.15, features `livekit` + `rustls-ring`): engine de 7,3 MB contra 16,2 MB da DLL. `livekit-protocol` fixado em 0.7.10 no `Cargo.lock` (0.7.11+ quebra o `livekit-api` 0.5.6). Runtime total: 46,9 MB.
  - WebView2 aprovado; o shell fica em Tauri. Permissões de mic/câmera pelo `Builder::on_permission_request` do próprio Tauri 2.12 (não precisa de `webview2-com`), só para a origem do app. Minimizado 60 s sem throttling.
  - LiveKit de dev nas portas 17880-17882 (havia outro serviço na 7880 via WSL); o segredo de dev tem ≥ 32 bytes porque o LiveKit 1.13 recusa HS256 com chave curta e a chave precisa ir em `--keys` (a variável `LIVEKIT_KEYS` não funcionou).
  - Pendências da fase 1 que dependem de hardware ou de uma pessoa: CPU na máquina de referência fraca; teste de vidro-a-vidro filmado em 240 fps entre duas máquinas na LAN (o método da página com relógio mediu 83 ms p50 em P2P na mesma máquina, incluindo os dois pipelines de exibição); runtime em máquina limpa (Windows Sandbox desativado no dev-1); câmera (dev-1 não tem webcam); zero-copy em AMD e Intel.
- 2026-10-29 (fases 2 e 3, backend), com autorização do usuário para seguir com as pendências de hardware da fase 1 em aberto:
  - Gateway: frames `{"op": "...", "d": {...}}`. O `ready` traz `user`, `community`, `members` (com `status`), `channels`, `voice_states` e `voice_session` (a sessão atual do usuário, para retomar depois de reconectar).
  - `voice_session.mode` ganhou o valor `"idle"` (sozinho no canal: não conectar a nada), que a regra da seção 3.2 já previa como "sfu ocioso". De `idle` para `p2p` a troca é imediata (não há mídia para derrubar); a histerese de 10 s vale só de `sfu` para `p2p`. Em P2P o `voice_session` traz `peer_user_id` e `polite` (menor `user_id`).
  - P2P só com exatamente 2 participantes; `P2P_MAX_PARTICIPANTS` < 2 desliga o P2P. Mesh continua no backlog.
  - Queda da conexão do gateway: o usuário fica no canal de voz por 10 s; um `voice_join` no mesmo canal (de qualquer conexão) reassume a vaga e recebe a sessão atual. Os webhooks do LiveKit ficam como confirmação secundária para a fase 7.
  - `POST /v1/auth/dev` (só com `AUTH_DEV=true`): login sem Google, pelo mesmo caminho de usuário/convite/sessão. Serve para desenvolvimento e testes com várias contas; nunca ligado em produção.
  - Convites: código de 10 caracteres de um alfabeto de 32 símbolos sem ambiguidade; `max_uses` e `expires_in_hours` opcionais. O primeiro usuário vira admin (lock consultivo no PostgreSQL contra corrida).
  - S3 de desenvolvimento: SeaweedFS (`chrislusf/seaweedfs:4.50`) na porta 9000, porque o MinIO deixou de publicar imagens. Produção continua AWS S3.
  - SQL com `sqlc` 1.30 rodando pela imagem Docker (`sqlc/sqlc`), código gerado em `api/internal/db`.
  - Testes de integração sobem a API inteira (`internal/app`) num schema PostgreSQL próprio por teste, com um provedor OIDC falso no lugar do Google; o contrato JSON fica em `api/internal/protocol/testdata`.
- 2026-10-29 (fases 4 a 8):
  - UI roda também num navegador comum em desenvolvimento (`shared/shell.ts` cai para `sessionStorage`/`window.open` fora do Tauri), para testar chamadas com vários usuários na mesma máquina (`desktop/scripts/participant.ps1`, Edge com microfone/câmera falsos). Ferramentas só de dev por parâmetro de URL: `dev_email`, `autojoin`, `report`, `force_p2p_fail`, `cam`, `mute`, `share`, `spike=scroll|webview`.
  - P2P de voz/câmera: o par impolido (maior `user_id`) cria os transceivers e faz a primeira oferta; o polido adota os da oferta. Câmera liga/desliga por `replaceTrack` + direção do transceiver (renegocia), e o outro lado vê pelo `mute`/`unmute` da track.
  - SFU: publicamos as nossas próprias `MediaStreamTrack`s no LiveKit (em vez de `setMicrophoneEnabled`) para o mesmo microfone sobreviver à troca P2P ⇄ SFU. A sessão não assina o próprio participante `#screen`.
  - Tela em P2P: a sinalização do engine viaja como `rtc_signal` `stream:"screen"`, com `payload.role` `"sender"` (oferta/ICE do engine) ou `"viewer"` (resposta/ICE de quem assiste), porque os dois pares podem compartilhar ao mesmo tempo.
  - Miniaturas do seletor por GDI (`PrintWindow`/`StretchBlt`), não por pipeline WGC, por causa do vazamento da fase 1. `list_sources` ganhou `thumbnails: true`.
  - O engine tenta até 3 encoders em ordem (HW no adapter da captura, HW em outro adapter, `x264enc`) e, para monitores, WGC e depois DXGI, quando um `start` falha (ex.: sessões NVENC tomadas por outro programa).
  - `p2p_failed` vindo de quem perdeu o par porque o outro fechou o app (conexão do gateway já caiu) não bloqueia o par; a carência de 10 s resolve.
  - Webhook do LiveKit (`POST /v1/livekit/webhook`, assinado): `participant_left` sem nova entrada em 10 s remove o usuário do canal quando o modo é SFU.
  - Instalador NSIS por usuário; DLLs do GStreamer na raiz da instalação (ao lado do engine) e plugins em `resources/gst/plugins`; atualizações assinadas com minisign (`tauri-plugin-updater`), `latest.json` no bucket de releases. A chave do updater foi gerada no dev-1 (`%USERPROFILE%\.tauri\discgo-updater.key`).
  - No teste de atualização local o Microsoft Defender colocou em quarentena o `discgo.exe` novo (`Trojan:Win32/Bearfoos.A!ml`, heurística de ML; a varredura manual do mesmo arquivo não acusa nada). A assinatura de código deixa de ser só "opcional" na prática: sem ela há risco de falso positivo além do aviso do SmartScreen.
  - Pendências que dependem de contas e máquinas do usuário: deploy real (VM, DNS, S3, IAM, OAuth do Google), chamadas entre redes domésticas, TURN forçado, máquina limpa, e a assinatura de código.
