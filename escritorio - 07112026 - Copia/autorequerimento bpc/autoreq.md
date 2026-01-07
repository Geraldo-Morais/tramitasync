# Fluxo da extensão INSS Automacao BPC

## 1. Visão geral da interface (popup)

Imagine o popup da extensão assim:

+--------------------------------------------------+
| Automacao BPC INSS                               |
+--------------------------------------------------+
| CPF do requerente: [ 093.010.875-29          ]   |
| Celular:          [ (77) 9 9927-1876         ]   |
| Cidade:           [ ita ▾ ]                     |
|                    ita | Vitoria da Conquista   |
+--------------------------------------------------+
| [ Iniciar automacao          ]                  |
| [ Retomar (CAPTCHA ou pausa) ]                  |
| [ Matar backdrops            ]                  |
+--------------------------------------------------+
| Status: <mensagem da automacao>                 |
+--------------------------------------------------+

- `CPF do requerente`: CPF que será digitado no fluxo.
- `Celular`: telefone de contato a ser cadastrado.
- `Cidade`: usada para CEP/unidade (ita / vca).
- `Iniciar automacao`: dispara toda a rotina do BPC.
- `Retomar (CAPTCHA ou pausa)`: manda o comando de “continuar” quando a automação está pausada (CAPTCHA, grupo familiar, etc.).
- `Matar backdrops`: comando manual para remover overlays de bloqueio da tela.
- `Status`: mostra o texto atual da automação (`[INSS-AUTO]` espelhado).

---

## 2. Fluxo de alto nível

### 2.1. Antes de qualquer coisa

**Ações na página (content.js)**

- Logo que o `content.js` carrega:
  - Cria a função `killAllBackdrops()` que remove SEM CONDIÇÃO:
    - `.modal-backdrop`
    - `.dtp-block-ui`
    - `.br-scrim`
    - `.a.loading`
    - `.a.loading.medium`
    - `.a.loading.medium.dtp-loading`
    - `.cdk-overlay-backdrop`
    - `.overlay-backdrop`
    - `.backdrop`
  - Remove imediatamente todos esses elementos.
  - Remove `modal-open` do `body` e do `html`.
  - Cria um `MutationObserver` observando `document.documentElement` (toda a árvore):
    - Qualquer mudança → roda `killAllBackdrops()` de novo.
  - Expõe `window.inssKillBackdrops = killAllBackdrops`.
  - Ativa o “atalho de Exigência”:
    - Torna as linhas de tarefas (tabela) clicáveis.
    - Clique na linha → abre nova aba em `/tarefas/detalhar_tarefa/{protocolo}?auto_tab=exigencia`.
    - Na tela de detalhes, tenta localizar e clicar na aba Exigência.
  - Prepara o motor de estado:
    - `state.running`, `state.paused`, `state.pauseReason`, `state.status`.
    - Banner azul no topo para mensagens (`[INSS-AUTO]`).
    - Funções utilitárias: `waitForStableUI`, `waitForElement`, `setNativeValue`, etc.
    - Pausa/retoma (`pauseForUser`, `window.inssAutoResume`).

---

### 2.2. Quando o usuário clica em “Iniciar automacao”

**Ações no popup (popup.js)**

- Lê os campos:
  - `cpf`, `celular`, `cidade`.
- Atualiza status: `"Executando automacao..."`.
- Descobre a aba ativa (via `chrome.tabs.query`).
- Executa script na aba ativa:
  - Chama `window.inssAutoStart({ cpf, celular, cidade })`.

**Ações na página (content.js / runBPCFlow)**

1. Marca `state.running = true`, limpa pausas e banner.
2. Chama `handleErrorScreenIfAny()`:
   - Se estiver na tela de erro “Não foi possível processar essa informação neste momento”:
     - Procura botão “Voltar”.
     - Clica em “Voltar”.
     - Aguarda um pequeno delay.
3. Entra em `waitForStableUI()`:
   - Em loop:
     - Chama `handleErrorScreenIfAny()` novamente (se cair na tela de erro de novo, volta).
     - Chama `ensureNoCaptchaBlock()`:
       - Procura:
         - `iframe[src*="recaptcha"]` visível.
         - `div.g-recaptcha` / `[data-sitekey*="recaptcha"]`.
         - mensagens `aria-live` mencionando captcha/robot/segurança.
         - `script[src*="recaptcha"]`.
         - Conteúdo escondido `.g-recaptcha-response`.
       - Se tiver CAPTCHA “ativo” → entra em pausa:
         - Atualiza status: “CAPTCHA detectado…”
         - Mostra banner.
         - `alert` explicando que precisa resolver e clicar em “Retomar”.
         - Fica aguardando até `window.inssAutoResume()` ser chamado.
     - Verifica bloqueios de UI:
       - `.a.loading.medium.dtp-loading`
       - `.dtp-block-ui`
       - `[aria-live="assertive"]` com texto de bloqueio.
       - `.wizard-panel` sem `active="active"`.
       - `.modal-backdrop` / `.br-scrim.foco` + `.br-modal` aberta.
     - Se houver modal, tenta pegar botão `Fechar/Cancelar/OK/Voltar` e clicar.
     - Se o estado continuar bloqueado até o timeout, lança erro.

> Observação: mesmo sem o `waitForStableUI`, o `killAllBackdrops` já está matando boa parte dos bloqueios visuais. O `waitForStableUI` serve para sincronizar com transições do wizard, requisições, etc.

---

### 2.3. Passo a passo do fluxo BPC

A seguir, o que `runBPCFlow` faz, em ordem:

1. **Abrir “Novo Requerimento”**
   - Status: `"Aguardando botao \"Novo Requerimento\""`  
   - `waitForStableUI()`
   - `waitForElement('button#btn-novo-requerimento, button.dtp-btn.dtp-primary')`
   - Clica no botão e espera `waitForStableUI()` de novo.

2. **Tela “Selecionar Serviço”**
   - Status: `"Selecionando servico BPC"`
   - Garante UI estável (`waitForStableUI`).
   - `selectComboboxOption('#idSelecionarServico', SERVICE_LABEL)`:
     - Input combobox:
       - Foca no `#idSelecionarServico`.
       - Clica no input.
       - Clica no botão de seta (`Exibir lista`), se existir.
       - Preenche o texto do serviço com `setNativeValue`.
     - Lista:
       - Espera `.br-list` / `[role="listbox"]`.
       - Percorre `.br-item [role="option"]`/`label`/`span`.
       - Usa `normalizeText(...)` para comparar sem acentos e sem depender de maiúsculas/minúsculas.
       - Localiza o item que contém `"Beneficio Assistencial a Pessoa com Deficiencia"`.
       - Clica no item.
   - Localiza `#btn-next` e clica → `waitForStableUI()`.

3. **Tela “Dados do Requerente” (CPF)**
   - Status: `"Preenchendo CPF"`
   - `waitForStableUI()`.
   - `waitForElement('[id="idRequerente.cpf"], input[id^="idRequerente\\.cpf"]')`.
   - Preenche CPF com `setNativeValue(cpf)`.
   - Procura botão de buscar dentro do container do CPF:
     - `cpfInput.parentElement.querySelector('button, .br-button')`.
   - Se achar:
     - Clica e espera `waitForStableUI()`.
   - `#btn-next` → clica e espera.

4. **Tela “Autorização CadÚnico”**
   - Status: `"Autorizando CadUnico"`
   - `waitForStableUI()`.
   - `waitForElement('#campo-autorizacaoCadunico')`.
   - Se não estiver marcado, clica.
   - `#btn-next` → clica e espera.

5. **Tela “Estado Civil”**
   - Status: `"Preenchendo estado civil"`
   - `waitForStableUI()`.
   - Procura `input[id^="selectEstadoCivil"]`.
   - `setNativeValue(..., 'Solteiro')`.
   - `#btn-next` → clica e espera.

6. **Pergunta de gastos**
   - Status: `"Respondendo pergunta de gastos"`
   - `waitForStableUI()`.
   - Busca `#perguntaGastos-Sim`, marca se não estiver marcado.
   - `#btn-next` → clica e espera.

7. **Switches do questionário**
   - Status: `"Marcando switches do questionario"`
   - `waitForStableUI()`.
   - Coleta `.respostaQuestionario input[type="checkbox"]`.
   - Marca os dois primeiros, se existirem.
   - `#btn-next` → clica e espera.

8. **Pergunta SUAS**
   - Status: `"Respondendo pergunta SUAS"`
   - `waitForStableUI()`.
   - Marca `#perguntaSUAS-Nao`.
   - `#btn-next` → clica e espera.

9. **Contato**
   - Status: `"Preenchendo contato"`
   - `waitForStableUI()`.
   - `waitForElement('#valorContatoInteressado')`.
   - `setNativeValue` com o celular fornecido.
   - Localiza botão “Adicionar”:
     - Dentro do form ou `button.br-button.primary.small`.
   - Clica e espera (UI estável).
   - Tenta fechar modal de interessados (`handleModalInteressadosIfAny`):
     - Procura modal com texto “interessad”.
     - Acha botão `Fechar/Cancelar/OK` e clica.
   - Se ainda existir botão “Fechar” visível, clica.
   - `#btn-next` → clica e espera.

10. **Grupo familiar (manual)**
    - Status: `"Tela de grupo familiar detectada..."` (interno).
    - `maybeHandleGrupoFamiliarManual`:
      - Procura textos contendo “grupo familiar”, “composicao familiar”, etc.
      - Procura botões “Adicionar/Incluir/Novo integrante/membro/pessoa”.
      - Se detectar essa tela:
        - `alert` dizendo para preencher manualmente.
        - Pausa a automação (`pauseForUser('GRUPO_FAMILIAR', ...)`).
        - Espera até `Retomar` (popup) ou `window.inssAutoResume()`.

11. **Perguntas adicionais (ids fixos)**
    - Status: `"Respondendo perguntas adicionais"`
    - `waitForStableUI()`.
    - Para cada id conhecido (`ca-e26...`, `ca-581a...`, `ca-5b91...`), se existir:
      - `setNativeValue` com respostas padrão.
    - `#btn-next` → clica e espera.

12. **CEP / unidade**
    - Status: `"Preenchendo CEP e buscando unidade"`
    - `waitForStableUI()`.
    - Localiza input com placeholder “CEP”.
    - Se cidade:
      - `ita` → CEP `45.700-000`
      - `vca` → CEP `45.026-250`
    - Preenche CEP.
    - Procura botão `Buscar`:
      - `button.br-button.primary` ou `button[title*="Buscar"]` etc.
    - Clica e espera.
    - Status: `"Selecionando agencia"`.
    - Procura `.unidade .nome`/`.unidade .label` com texto:
      - `ITA...` ou `VITORIA DA CONQUISTA` (normalizado).
    - Se encontrar, clica na `.unidade` correspondente.
    - `#btn-next` → clica e espera.

13. **Confirmar requerimento**
    - Status: `"Confirmando requerimento"`
    - `waitForStableUI()`.
    - `waitForElement('#campo-declaracaoConfirmar')`.
    - Marca checkbox.
    - `#btn-next` → clica e espera.
    - Status final: `"Automacao concluida"`.
    - `alert('Automacao concluida!')`.

---

## 3. Botão “Retomar (CAPTCHA ou pausa)” (popup)

Quando o usuário clica em **Retomar**:

- Popup:
  - Descobre aba ativa.
  - Executa um script que chama:
    - `window.inssAutoResume('popup')` na página.
    - Retorna o `window.__inssAutomationStatus` (estado atual textual).
  - Atualiza o `status` do popup com essa mensagem.

- Página:
  - Se existe uma pausa pendente (CAPTCHA ou grupo familiar):
    - `inssAutoResume` resolve a `Promise` que estava parada em `pauseForUser`.
    - Zera `state.paused`/`resumeResolver`.
    - Esconde o banner.
    - O fluxo continua do ponto onde estava.

---

## 4. Botão “Matar backdrops” (popup)

Quando o usuário clica em **Matar backdrops**:

- Popup:
  - Descobre aba ativa.
  - Executa script:
    - Se existir `window.inssKillBackdrops`, chama.
    - Atualiza status com “Backdrops removidos.” ou mensagem de erro.

- Página:
  - `inssKillBackdrops` roda:
    - Remove imediatamente todos os seletores configurados.
    - Remove `modal-open` de `body` e `html`.
  - O `MutationObserver` continua rodando, então qualquer overlay reincidente também será apagado.

---

## 5. Atalho “Exigência” na lista de tarefas

### 5.1. Na tela de tarefas

- O `content.js`:
  - Injeta CSS para deixar linhas `tr.dtp-table-wrapper-row` com cursor pointer e hover.
  - Adiciona um listener no `document` em modo captura:
    - Quando o usuário clica em uma linha de tarefa:
      - Se for botão de imprimir, ignora.
      - `preventDefault` + `stopPropagation` para impedir a navegação SPA original.
      - Lê o protocolo na primeira célula (`row.cells[0].innerText`).
      - Abre nova aba:
        - `https://atendimento.inss.gov.br/tarefas/detalhar_tarefa/{PROTOCOLO}?auto_tab=exigencia`.

### 5.2. Na tela de detalhes da tarefa

- Assim que a página `/tarefas/detalhar_tarefa/...` carrega:
  - `setupExigenciaShortcut` verifica a URL:
    - Se contém `/tarefas/detalhar_tarefa/` e `auto_tab=exigencia`:
      - Chama `activateExigenciaTab()`:
        - Em loop (até ~15s):
          - `waitForStableUI({ timeout: 5000 })`.
          - Procura `a[href="#exigencia"]` ou `a[aria-controls="exigencia"]`.
          - Se encontrar e ainda não estiver ativa:
            - Clica.
            - Loga `[INSS-AUTO] Aba Exigencia clicada`.
            - Sai do loop.
        - Se não encontrar até o timeout, registra log de falha.

---

## 6. Resumo mental do que acontece “por trás”

- Ao carregar o site:
  - A extensão entra como “camada de controle”, matando overlays e observando mutações.
  - Não mexe em `sr-only` nem `aria-live` (acessibilidade mantida).
  - Detecta CAPTCHA, mas não interfere nele: só pausa, avisa e espera o humano.

- Quando você usa o popup:
  - Ele é apenas um painel de controle:
    - Dispara a automação (`inssAutoStart`).
    - Pede retomada (`inssAutoResume`).
    - Força remoção de backdrops (`inssKillBackdrops`).
  - Tudo o resto é executado dentro da própria página do INSS (content script).

- A automação:
  - Age de forma sequencial, com forte uso de:
    - `waitForStableUI()` para sincronizar com loadings e wizards.
    - `waitForElement()` com `MutationObserver` para achar elementos na DOM reativa.
    - `setNativeValue()` para gerar eventos naturais (input, change, blur) compatíveis com React/Angular.
  - Em pontos sensíveis (CAPTCHA, grupo familiar, erro global), não tenta burlar:
    - Erro → clica “Voltar” e tenta seguir.
    - CAPTCHA → pausa e pede você.
    - Grupo familiar → pausa até você preencher.

