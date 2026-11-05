# Handoff — Provisão de armazenamento do browser

Documento de continuação com checkpoints históricos. O estado atual abaixo prevalece sobre instruções antigas de investigação sem wiring.

## Continuação integrada — 2026-11-05

O checkout começou limpo em `e168bd5`, branch `t3/native-macos-app`. A pasta `.slim/deepwork/browser-storage-provisioning/` não existe neste worktree; as suas pesquisas/revisões não foram assumidas como verificadas. A divergência do alvo foi resolvida com **substituição virtual apenas do módulo-folha**, guards por realm e gates de build.

A auditoria inicial observou os defeitos previstos. Depois, o pedido explícito do owner para continuar toda a implementação autorizou corrigir e integrar localmente a facade, o coordenador e a UI. A restrição antiga de não fazer wiring sem nova autorização está satisfeita para este trabalho local; não autoriza qualquer acesso real, migração ou rollout.

**Implementado:** arranque existing-only; schema v1 validado antes dos metadados; criação por confirmação separada de uso único; sessão/geração e transações detidas pela facade; invalidação em versionchange; queries/export/player ligados à geração; estados separados para missing, base vazia, incompatível, blocked/draining e efeitos IDB/localStorage parciais. O repositório já não obtém o handle cru. Nome/versão/schema e histórico de produção não foram migrados ou reparados.

**Testado:** 13 cenários com módulos reais em fixtures Incognito descartáveis, mais confirmação concorrente e blocked/draining em dois separadores reais. Regressão web: 461 aprovados/2 ignorados, TypeScript/lint/build aprovados (um warning preexistente). [Fase 2 atual](browser-storage-phase2.md), [evidência final](../evidence/browser-storage-integrated-final-2026-11-05.json). Os resultados anteriores ficam preservados como checkpoints, não como evidência do código final.

**Ainda aberto:** aceitação visual e playback da nova UI nativa, conta/API/Keychain reais e segurança de produção, política do YouTube, acesso a dados reais e rollout. A app nativa já integra biblioteca local/transferência/conta/player em código, com testes sintéticos; ver o [plano principal](native-macos-app.md#current-continuation--2026-11-05-local-work-no-rollout) e o [ensaio Mac agrupado](../../macos/README.md#one-grouped-ui-rehearsal).

A confirmação anterior do owner (“sim funciona sempre”) é evidência qualitativa de reprodução, sem contagens/logs inventados. Não se repete o teste antigo; o ensaio atual cobre as alterações posteriores de UI/player. A UI web de export/divulgação já existia antes desta continuação — a afirmação antiga de que não existia estava errada. O export continua a omitir e divulgar órfãos sem alterar o histórico de origem; não prova proveniência nem continuidade entre ocorrências.

## Registo histórico do handoff original

As secções 1–8 abaixo são preservadas com o estado e restrições daquele checkpoint. Onde dizem “atual”, “inerte” ou “próximo passo”, consultar a continuação acima. A pasta `.slim` listada é uma referência histórica de artefactos ausentes, não evidência disponível. Não houve biblioteca real, migração de produção ou deploy nesta continuação.

## 1. Objetivo maior

O objetivo do produto é uma app **macOS nativa em SwiftUI** (não um site reembalado), com interface própria, APIs Vercel autenticadas partilhadas com o site, login Google via Supabase e apenas **links/IDs de playlists** na nuvem. Conteúdo das playlists, fila, histórico e preferências ficam locais (SwiftData). O player de vídeo é o iframe oficial do YouTube dentro de WKWebView, apenas para reprodução — nunca para a interface.

O protótipo P0 de reprodução recebeu um **NO-GO técnico**: falhou a segunda transição natural de fila em execuções minimizadas e com Cmd+H; a comparação com WKWebView direto mostrou callbacks melhores, mas a confirmação áudio final em hidden ficou pendente. O owner decidiu continuar o protótipo para uso pessoal apesar dos gates abertos. A política do YouTube sobre reprodução em background continua **não resolvida e bloqueante para release**. Nada disto é aprovação de release.

O trabalho de armazenamento do browser é uma lane separada e independente desse objetivo: preservar a biblioteca local e impedir criação silenciosa de bases de dados. O site continua a ser a referência de comportamento local.

## 2. Decisões já tomadas

- **Política aprovada, ainda não aplicada:** o owner decidiu que a ausência de base de dados local **não** é consentimento nem prova de primeiro uso. A app deve fazer uma verificação *existing-only* e só pode criar após uma **confirmação explícita, separada e de uso único**.
- **Criação única e validada.** A elegibilidade para criar é consumida antes do pedido nativo; duplo clique e leituras concorrentes não podem juntar-se à criação. Depois de criada, a base é validada antes de ser considerada pronta. Se a criação encontrar uma base existente, não escreve schema nem metadados e exige nova verificação.
- **Metadados existentes preservados após validação.** O owner escolheu (2026-11-05) manter o comportamento atual de `ensureStorageMigrationMeta` / marcador localStorage **depois** de validada uma biblioteca existente. Efeitos em IndexedDB e localStorage são avaliados em separado. Isto é intenção registada, não autorização para escrever metadados em produção.
- **Eventos de conclusão incertos ou de sugestão podem ficar só no browser.** Eventos de sugestão/proveniência desconhecida podem ser temporariamente excluídos do export, com **divulgação clara** dessa omissão. Histórico existente não pode ser apagado nem reescrito. A divulgação ainda não foi implementada/verificada.
- **Sem alterações destrutivas por defeito.** Nada de bump de schema, `deleteDatabase`, reparação automática, migração de produção, deploy ou remoção de dados sem uma decisão e validação separadas.
- **Sem promessas não provadas.** Não afirmar deteção real de primeiro uso, backup, coordenação entre separadores, preservação contra outra aba, durabilidade, recuperação de crash, migração de produção ou prontidão de release.

## 3. Estado atual

- **A produção ainda cria automaticamente.** `src/lib/storage/browser-db.ts` continua a fazer `window.indexedDB.open(DB_NAME, DB_VERSION)` e a chamar `createStores()` em `onupgradeneeded`. Ou seja, uma base ausente é recriada vazia no próximo open. O coordenador da Fase 1 é **inerte e não está ligado** a nenhum caminho de produção.
- `src/lib/storage/index.ts` mantém um `dbPromise` com o handle cru em cache; todas as operações passam por `initializeStorage()`, que chama `ensureStorageMigrationMeta()`. Por isso, até uma leitura pode abrir a base, abrir uma transação `readwrite` em `meta` e escrever `schemaVersion`/`migratedFromLegacy` e o marcador localStorage. O export também pode desencadear `initializeStorage()`; `readTransferSnapshot` em si não toca em `meta`.
- `src/stores/playlist-store.ts` (`getCompletedVideoIds`) abre a sua própria transação no handle cru, fora da facade. O cache de sugestões e a UI dependem de `browserStorage`.
- A UI de erro existente (`QueryReadError`, `showReadError`/`readOnly`) é guiada por estado de query, não por estado da base. Não distingue `missing`, `incompatible`, `blocked`, `indeterminate`, `versionchange` ou handle morto.
- **Fase 1 (concluída como experiência isolada):** `src/lib/storage/browser-provisioning.ts` é um coordenador *target-bound*, sem imports de aplicação e sem wiring. A lane de testes reporta **42 cenários sintéticos** (43 outcomes incluindo o agregado de não-claims) em Chromium nativo local, com nomes de fixture únicos, perfil descartável, origem loopback e allowlist exata. Não abriu `tubeshuffle_local` nem tocou em dados reais.
- **Revisão independente:** houve três tentativas; a terceira encontrou uma lacuna na evidência de rollback. O owner autorizou um reforço do teste e **uma revisão focada excecional**, que não encontrou bloqueador remanescente. A garantia de rollback está limitada à transação de schema sintética; não prova efeitos colaterais fora dela.
- **Limites da evidência:** o ensaio do coordenador do browser é Linux/Chromium headless, com dados sintéticos e algumas falhas injetadas; não validou bases reais nem Safari. Separadamente, o owner confirmou no Mac o ensaio descartável SwiftData de bloqueio entre processos e reabertura. Esse ensaio também não valida dados reais ou prontidão de produção. Os resultados Xcode não forneceram valores medidos de poupança de memória.
- **Gates de produção continuam abertos:** integração normal da conta e APIs, verificações mais amplas de RLS/segurança, política do YouTube e atribuição segura de histórico. A correção da corrida de shuffle web e a UI genérica de erro de leitura foram implementadas e testadas, mas não resolvem todos os riscos de histórico ou separadores.

## 4. Próximo passo — Fase 2

Estado registado: **Fase 2 — preparação de integração isolada**; próximo item é reconciliar a substituição do módulo-folha (*leaf-target alias*) com a reescrita total do módulo, **antes** de construir o harness sintético.

1. **Decidir a estratégia de substituição do alvo.**
   - `phase2-harness-map.md` propõe extrair `DB_NAME`/`DB_VERSION` para um novo módulo-folha (`src/lib/storage/browser-db-target.ts`) e usar um `alias` esbuild apenas no build de teste.
   - `phase2-esbuild-research.md` recomenda um plugin `onResolve`/`onLoad` com módulo virtual, verificação de caminho e gate pós-build; o exemplo reescreve o módulo completo. Essa proposta e a alternativa de substituir apenas um módulo-folha ainda não foram reconciliadas nem aprovadas.
   - Resolver esta divergência explicitamente; não assumir que uma das opções já foi escolhida.
2. **Construir o harness sintético seguro.**
   - Substituição apenas no grafo de teste; **nenhum override de alvo em runtime de produção**. O literal de produção deve permanecer na fonte e ser provado num build sem alias.
   - Guards antes de qualquer import de código de aplicação, em **todos os realms** que possam abrir a base (não só na página principal). Rejeitar nomes de produção e legado, e rejeitar `deleteDatabase`.
   - Guardar e inspecionar localStorage com allowlist exata de chaves; verificar efeitos de IndexedDB e localStorage separadamente.
   - Fixtures únicas por execução; suportar duas abas/realms para confirmações concorrentes e estados blocked/draining; o runner atual tem reporte *single-shot* e iframe sem scripts — isto precisa de ser resolvido ou contornado de forma honesta.
   - Não reutilizar `migration-guard.ts`/`playlist-guard.ts` sem alterações: usam nomes reais de base.
3. **Preservar histórico e comportamento existente.** Testar com fixtures sintéticas de schema v1, playlists, vídeos, histórico normal e órfão, metadados e marcadores localStorage; comparar os registos sem alterações inesperadas e verificar separadamente os efeitos de metadados aprovados. Sem bump de schema, sem deleção, sem reparação e sem deploy.
4. **Nunca tocar em bases reais** sem autorização explícita do owner. A evidência deve continuar em perfis descartáveis e origem loopback.
5. **Não repetir alegações de memória.** Os relatos Mac anteriores (incluindo execuções Xcode) não fornecem contagem individual de testes nem poupança de memória medida; não transformar isso em claim.

Critérios de paragem: política de metadados ou rollout por resolver; qualquer bypass de handle cru; trabalho stale capaz de alcançar uma nova geração; aborto não confirmado; guard de fixture inseguro; UI incapaz de distinguir ausente de vazio; ou qualquer proposta de reparar, apagar, subir schema, aceder a base real ou alegar recuperação.

## 5. Fases registadas

- **Fase 1 — coordenador isolado + testes sintéticos + revisão independente.** Concluída como experiência inerte.
- **Fase 2 — preparação de integração isolada.** Em curso; decisão de harness e evidência sintética antes de qualquer wiring.
- **Fase 3 — UI de confirmação e recuperação** (designer), ligada só depois do gate de armazenamento.
- **Final — validação focada, limites visíveis ao owner e decisão de rollout faseado.**

## 6. Artefactos exatos

Plano principal e decisões de produto:

- `docs/plans/native-macos-app.md` — objetivo macOS, P0/P1/P2/P3/P4/P5, decisões do owner e evidência nativa; inclui a secção “Browser storage provisioning — Phase 1 status, 2026-11-05”.

Plano e registo desta lane:

- `.slim/deepwork/browser-storage-provisioning/progress.md` — estado, decisões, itens abertos e próximo passo. **A pasta `.slim/deepwork/` é ignorada pelo Git**: estes artefactos só estarão disponíveis noutro chat que use o mesmo diretório de trabalho; não seguem automaticamente numa nova clonagem.
- `.slim/deepwork/browser-storage-provisioning/phase2-plan.md` — arquitetura alvo, criação única, gerações, UI, cenários e milestones.
- `.slim/deepwork/browser-storage-provisioning/phase2-storage-map.md` — mapa de efeitos colaterais, handles crus e hooks de UI.
- `.slim/deepwork/browser-storage-provisioning/phase2-harness-map.md` — mapa do runner, alias de alvo, guards por realm e lacunas.
- `.slim/deepwork/browser-storage-provisioning/phase2-esbuild-research.md` — pesquisa do plugin `onResolve`/`onLoad` e gates de metafile.

Evidência da Fase 1:

- `.slim/deepwork/browser-storage-provisioning/phase1-impl.md`
- `.slim/deepwork/browser-storage-provisioning/phase1-tests.md`
- `.slim/deepwork/browser-storage-provisioning/phase1-structure.md`
- `.slim/deepwork/browser-storage-provisioning/phase1-review.md`
- `.slim/deepwork/browser-storage-provisioning/phase1-review-2.md`
- `.slim/deepwork/browser-storage-provisioning/phase1-review-3.md`
- `.slim/deepwork/browser-storage-provisioning/phase1-review-exception.md`
- `.slim/deepwork/browser-storage-provisioning/phase1-validation.md`
- `.slim/deepwork/browser-storage-provisioning/phase1-docs.md`
- `.slim/deepwork/browser-storage-provisioning/phase1-commit.md`

Ficheiros de código relevantes (leitura, não alteração nesta handoff):

- `src/lib/storage/browser-db.ts`, `src/lib/storage/index.ts`, `src/lib/storage/storage-migrations.ts`
- `src/lib/storage/browser-provisioning.ts` (inerte)
- `src/stores/playlist-store.ts`, `src/lib/transfer/export.ts`
- `tests/browser/run-completion-journal-guard.mjs`, `tests/browser/browser-provisioning-guard.ts`

## 7. Git e validação

Na verificação local sem rede, a branch era `t3/macos-app`, em `cf91f2e6c01c30b74758e8d8244b34d71bdddea8`, alinhada com a referência local `origin/t3/macos-app`. Esta verificação ocorreu antes da criação deste handoff; este ficheiro ainda não está em commit nem foi enviado. Confirma o estado real no próximo chat.

## 8. Regras para a próxima sessão

1. Ler `codemap.md` e `docs/plans/native-macos-app.md`; se os ficheiros ignorados existirem no mesmo diretório de trabalho, ler também `progress.md` e `phase2-plan.md`.
2. Tratar a Fase 2 como investigação e harness, não como implementação de produção.
3. Não ligar o coordenador, não remover o caminho de auto-criação, não alterar metadados, não subir schema e não fazer deploy sem aprovação explícita e separada.
4. Não abrir bases reais, não usar dados de utilizador e não executar guards antigos contra nomes de produção.
5. Distinguir sempre observação real, evidência sintética, falha injetada e intenção registada; não promover uma à outra.
