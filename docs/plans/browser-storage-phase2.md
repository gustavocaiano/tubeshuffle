# Browser storage — Fase 2, 2026-11-05

## Estado atual — integração local validada em fixtures

A Fase 2 passou de preparação para **integração no código da aplicação** após o pedido explícito do owner para continuar toda a implementação. O coordenador já não está desligado: `browser-session.ts` liga-o à facade, às queries e à confirmação separada na UI. Isto não é rollout nem validação de bibliotecas reais.

- Arranque real: operações de `browserStorage` → sessão/geração → `openExisting` → validação de schema → política de metadados → transação solicitada. Uma base ausente não é criada por uma leitura. Uma base vazia existente permanece distinta de uma base ausente.
- Criação: elegibilidade consumida antes do pedido nativo, diálogo separado, sem adesão de leituras/segundo clique; se outra aba criar entretanto, exige recheck. Só fica pronta depois de validar e abrir explicitamente como existente.
- Ciclo de vida: `versionchange` fecha a ligação cooperativa, invalida geração e trabalho pendente. Queries e callbacks não reutilizam dados/efeitos de uma geração antiga. Writes não são repetidos automaticamente; uma escrita já comprometida pode preceder a invalidação.
- Metadados: preservada a política de `schemaVersion`/`migratedFromLegacy` apenas após validar schema. Falha de leitura localStorage precede a transação; falha do marcador depois do commit IDB é um estado separado, explicado na UI, sem alegar rollback global.
- Dados: mesmo nome/v1/schema de produção, sem reparação, deleção ou remapeamento do histórico. O lookup de concluídos devolve IDs armazenados, incluindo legados sem correspondência. Import/refresh destrutivo continua bloqueado.

A estratégia reconciliada mantém-se: substituição virtual exata **apenas do módulo-folha de constantes**, com gates de bundle/metafile e build sem substituição que nunca é servido. Todos os módulos de opener, schema, sessão, facade, repositório e export são os reais. Os guards entram antes de imports em cada realm; nomes/chaves permitidos são únicos e sintéticos. Não há override de alvo em runtime de produção.

### Evidência final

[Resultado bruto com hashes](../evidence/browser-storage-integrated-final-2026-11-05.json); [runner e instruções](../../tests/browser/storage-startup/README.md).

**13 cenários passaram**, cada um com dois realms guardados: controlos negativos; ausência sem criação; schema/linhas/metadados existentes; sinais legados; falha injetada de leitura localStorage; falha do marcador após commit; schema incompatível sem reparação; invalidação/stale após versionchange; confirmação dupla/concorrente integrada; blocked/draining; export real com órfão divulgado; histórico exato em dois realms; aborto nativo injetado após sucesso do pedido. Os erros esperados são condições verificadas dos cenários, não falhas omitidas.

**Dois separadores reais adicionais**, no mesmo perfil Incognito descartável: ambos observaram missing; confirmações sobrepostas produziram ready numa aba e recheck-required na outra; recheck explícito abriu a mesma v1. Depois, um handle cru criado deliberadamente pela fixture bloqueou um coordenador v2 inerte. As duas sessões da aplicação fecharam cooperativamente; a libertação do blocker permitiu drenar e abortar o upgrade tardio. Recheck abriu v1 intacta nas duas abas, sem pedidos pendentes. Isto não prova coordenação com todo o JavaScript possível nem permite um bump v2 de produção.

Regressão final: **461 testes web aprovados, 2 ignorados**, TypeScript/build aprovados; ESLint sem erros, com um warning `_id` preexistente. Os dois skips não contam como pass. Testes de UI sintética verificam a confirmação e invalidação/refetch; não substituem uma revisão visual em Safari. Handles/tabs fechados e servidores terminados; não se afirma eliminação física do perfil gerido pelo host.

### Limites e próximo gate

Proteção **implementada e testada em ambiente sintético**, sem autorização de rollout. Nenhuma base real, migração, alteração de versão/schema de produção, reparação, deploy ou biblioteca nativa real foi usada. Os artefactos `.slim` continuam ausentes. Schema validado não significa que todos os valores históricos tenham proveniência válida; não há promessa de durabilidade, recuperação de crash, atomicidade IDB/localStorage ou defesa contra scripts não cooperativos.

A UI de export web já existia no baseline; a auditoria inicial errou ao declará-la ausente. Agora está também ligada à geração de armazenamento. O export divulga os órfãos omitidos e mantém as linhas de origem. Fila/preferências/cache, journal inerte e eventos de sugestões não entram no v1. O import nativo tem preview e só aceita biblioteca vazia; não resolve continuidade ambígua. Ver [plano nativo](native-macos-app.md#current-continuation--2026-11-05-local-work-no-rollout) para a aceitação integrada e o pedido de UI agrupado.

## Registo histórico — antes da integração

O texto abaixo preserva observações e critérios de paragem dos checkpoints anteriores. As frases “ainda não integrado”, “próximo milestone” e resultados de 11 cenários descrevem aqueles estados, não o checkout atual. A evidência anterior não foi substituída nem promovida a validação da implementação final.

## Estado e decisão

**Harness validado; proteção de produção ainda não integrada.** O checkout começou limpo em `e168bd5`, branch `t3/native-macos-app`. `codemap.md`, o plano nativo e o handoff estavam presentes. Toda a pasta `.slim/deepwork/browser-storage-provisioning/` estava ausente: progress, phase2-plan/storage-map/harness-map/esbuild-research e os dez artefactos phase1 listados no handoff não foram lidos nem revalidados. O seu conteúdo foi reconstruído a partir dos ficheiros versionados; os relatos históricos continuam atribuídos ao handoff.

Reconciliação escolhida: **módulo-folha + resolução virtual exata**. Extrair apenas `DB_NAME`/`DB_VERSION` para `browser-db-target.ts`, mantendo os valores e re-exports públicos. No build de teste, `onResolve`/`onLoad` substituem apenas esse módulo, após verificar os caminhos reais. Gates de metafile/bundle exigem os módulos de aplicação reais e ausência do alvo de produção. Um build sem substituição prova que o alvo original permanece; nunca é servido ao browser. Não reescrever o módulo completo: isso esconderia precisamente o abridor/schema que precisamos de testar. Não usar override em runtime de produção. Fontes: [esbuild plugins](https://esbuild.github.io/plugins/#on-resolve), [metafile](https://esbuild.github.io/api/#metafile).

A única alteração funcionalmente neutra no código de aplicação é esta extração. Não foram ligados o coordenador ou UI, removida a auto-criação, alterado schema/v1/metadados/histórico, feito deploy, aberto um perfil de utilizador ou uma base real. A versão 2 aparece apenas em fixtures descartáveis para provocar eventos nativos de ciclo de vida.

## Continuação após confirmação do player

O owner respondeu “sim funciona sempre” ao teste de reprodução/passagem automática de músicas nos três estados. O relato qualitativo foi registado no plano nativo, sem inventar contagens, logs ou identidade do binário. Não é necessário repetir o mesmo pedido para continuar o desenvolvimento incremental.

Foi resolvido o bypass do repositório: `playlistRepository.getCompletedVideoIds` chama agora `browserStorage.getCompletedVideoIds`; a facade já não expõe `initialize`. A leitura do histórico espera pelo pedido **e** pela conclusão da transação. Mantém exatamente os IDs armazenados, incluindo IDs legados sem correspondência, e não altera linhas. O export de baixo nível `initializeStorage` continua disponível ao código interno/guards: ainda não há controlo de gerações nem encapsulamento completo.

Treze cenários passaram com o repositório real no bundle. Os dois novos verificam filtragem/IDs/preservação em dois realms e a rejeição de um aborto nativo injetado depois do sucesso do pedido. [Evidência desta continuação](../evidence/browser-storage-history-boundary-2026-11-05.json). O resultado anterior de onze cenários e os seus hashes ficam preservados como evidência histórica. Mantêm-se a auto-criação, o cache stale e os efeitos separados IDB/localStorage; o coordenador está desligado da aplicação.

As observações abaixo descrevem a auditoria inicial, anterior a esta pequena alteração de fronteira.

## Caminho real reconstruído

`listLocalPlaylists` / leituras de playlist / `exportBrowserLibrary` → `initializeStorage` → `dbPromise` → `openBrowserDb` → `ensureStorageMigrationMeta` → transação de leitura solicitada.

- O abridor pode criar os quatro stores no primeiro open. Não valida previamente schema existente nem trata `versionchange`.
- A facade memoriza o handle/promessa cru, inclusive após fecho/falha; todas as operações voltam ao inicializador.
- O inicializador lê sinais em localStorage, abre `meta` em `readwrite`, pode preencher `schemaVersion`/`migratedFromLegacy`, espera commit e só depois escreve o marcador localStorage. **Não há atomicidade entre os dois sistemas.**
- `playlistRepository.getCompletedVideoIds` ainda recebe o handle cru e constrói a transação fora da facade. É um bypass do futuro controlo de gerações.
- `readTransferSnapshot` lê três stores numa transação consistente; sem handle injetado, o inicializador pode escrever meta antes dela. As opções de teste não provam export read-only de ponta a ponta.
- A UI é dirigida por queries; não conhece `missing`, `blocked`, `draining`, `indeterminate`, `incompatible` nem a geração do handle.

## Evidência desta sessão

Harness: [instruções e limites](../../tests/browser/storage-startup/README.md). Resultado bruto: [JSON](../evidence/browser-storage-phase2-2026-11-05.json).

Ambiente observado: macOS 27.0.1 (26A434), arm64; browser T3 Incognito, Chrome 152.0.7977.169 / Electron 44.10.1. A string de user-agent anuncia Intel/10_15_7; não foi usada para inferir arquitetura/versão do host. Isto não é Safari nem um resultado de áudio confirmado pelo owner.

| Ensaio | Observação | Limite |
| --- | --- | --- |
| Guards em dois realms | Nomes produção/legado, delete, chaves não permitidas, clear e fetch rejeitados antes do acesso nativo | Tentativas negativas deliberadas contabilizadas; não afirmar zero tentativas globalmente |
| Ausência, dois inicializadores reais | Uma criação automática, biblioteca vazia e meta `1/false` | **Defeito confirmado**, não proteção concluída |
| v1 existente e metadados | Registos/schema/índices preservados, incluindo histórico órfão; duas transações readwrite meta; marcador localStorage escrito | Dados sintéticos; não prova zero escritas redundantes |
| Sinal legado | Meta preenchida; sinal mantido; marcador criado; biblioteca/histórico intactos | Não copia nem abre base legada |
| localStorage read falha (injetada) | Inicialização rejeitada antes da escrita meta | Não é falha nativa observada de quota/permissão |
| localStorage write falha (injetada) | Meta já comprometida; leitura rejeita; repetição explícita escreve marcador | Não prometer rollback global |
| Schema v1 incompleto | `NotFoundError`, sem reparação | Falta validação preflight na aplicação |
| Handle cru/stale | Bloqueia tentativa noutro realm; após fecho explícito, cache morto produz `InvalidStateError` | **Bloqueador de integração**, não corrigido |
| Coordenadores concorrentes | Dois missing, um created, outro existing-found; duplo clique/leitura recusados durante criação | Coordenador inerte, não arranque da app |
| Blocked/draining | Evento nativo, aborto de upgrade tardio e recheck obrigatório; schema/registos v1 mantidos | Não coordenação de todas as operações da aplicação |
| Export real | Órfão omitido e reportado no resultado; histórico mantido; meta inicializada | Não há UI de export/disclosure nem prova de proveniência |

Onze cenários passaram, com dois iframes por cenário. Ensaio adicional com **dois separadores reais** no mesmo perfil descartável confirmou duas observações missing, um created e um existing-found; um handle cru da facade bloqueou o coordenador do outro separador, que abortou a tentativa tardia após o fecho explícito e exigiu recheck. As execuções usam nomes únicos diferentes; o JSON distingue a suite final do ensaio dos separadores.

Fechados os handles e separadores de teste; servidores loopback terminados. Não foi chamado `deleteDatabase` nativo nem removido qualquer perfil no disco. O perfil Incognito é gerido pelo host: o fecho dos separadores não é prova de eliminação física dos seus ficheiros. CSP/guards são proteção em camadas, **não firewall do sistema**.

## Gate antes do wiring

O critério de paragem do handoff foi atingido: handle cru fora da facade + cache stale + UI sem estado de armazenamento. Por isso o harness não autoriza substituir hoje o opener da aplicação nem avançar para import de dados reais.

Próximo milestone técnico, apenas código local e fixtures até validação:

1. Definir uma facade que detenha a ligação e a geração; consumidores recebem operações, nunca `IDBDatabase`. O lookup de concluídos já foi movido; falta a posse da ligação/geração. Invalidar operações pendentes/stale antes de atingirem nova geração; não repetir writes automaticamente.
2. Validar schema/indexes v1 **sem reparar** antes do inicializador. Manter a política de metadados escolhida pelo owner, distinguindo commit IDB e escrita do marcador. Se localStorage falhar após commit, mostrar a incerteza e manter ações bloqueadas; não desfazer meta nem repetir automaticamente a escrita.
3. Publicar estado observável do coordenador e ligar queries/player à geração. Missing é diferente de biblioteca vazia. Blocked/draining/incompatible/indeterminate não podem habilitar import, export ou player.
4. Só depois integrar confirmação explícita de uso único. Revalidar concorrência entre separadores, remount/Strict Mode, confirmação dupla, invalidação durante leitura/export, schema incompatível e falhas após commit. Não acrescentar migração nem novo schema.
5. Rever o resultado concreto de integração antes de testar bibliotecas reais ou rollout. Essas ações continuam a exigir autorização separada do owner.

## Transferência e omissões

O export atual retorna `omittedOrphans`; no ensaio uma linha órfã ficou fora do ficheiro e permaneceu intacta na base. Queue/preferências/cache não fazem parte do v1. Eventos dos módulos/journal inertes também não entram no snapshot de `playHistory`. O histórico legado não tem prova de proveniência: não podemos etiquetar retroativamente linhas como sugestões, resolver continuidade por igualdade de IDs nem prometer export completo. A UI de divulgação de omissões, o preview/mapeamento seguro e o import transacional nativo continuam por implementar. Mantêm-se bloqueados sync/reimport destrutivos já protegidos pelo repositório.
