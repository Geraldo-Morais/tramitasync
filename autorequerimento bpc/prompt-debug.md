# Prompt para outra IA investigar duplicação do serviço (INSS BPC)

## Contexto atual
- Extensão Chrome Manifest V3, content script `content.js` automatiza fluxo BPC em `https://atendimento.inss.gov.br/requerimentos`.
- Seleção do serviço é feita no combo `#idSelecionarServico` (br-select), clicando no item com rádio `value/id = 1655` (Benefício Assistencial à Pessoa com Deficiência).
- Após clicar, o React/SPA às vezes repõe/concatena o texto no input, ficando duplicado.

## Problema observado (logs e tela)
- Mesmo depois de clicar no item, o valor do input fica:
  - `Benefício Assistencial à Pessoa com DeficiênciaAtendimento a distânciaBenefício Assistencial à Pessoa com Deficiência`
- Logs recentes mostram o clique e a escrita, mas ainda duplica:
  ```
  [INSS-AUTO] Selecionando servico BPC
  [INSS-AUTO] Tentando selecionar servico via combobox (modo direto).
  [INSS-AUTO] Seletor encontrado: #idSelecionarServico
  [INSS-AUTO] Valor no input apos tentativa: Beneficio Assistencial a Pessoa com Deficiencia
  [INSS-AUTO] Seletor encontrado: #idSelecionarServico-itens, .br-list[role="listbox"]
  [INSS-AUTO] Clicando item identificado para o servico.
  [INSS-AUTO] Valor final no input de servico: Benefício Assistencial à Pessoa com DeficiênciaAtendimento a distânciaBenefício Assistencial à Pessoa com Deficiência
  ```
- Resultado prático: ao clicar “Avançar”, o site exibe “Favor preencher os campos obrigatórios — É necessário selecionar um serviço”, indicando que o click/seleção não foi reconhecido apesar do texto estar no input.

## Fluxo esperado (alto nível)
1. Na tela “Selecionar Serviço”, abrir o combobox `#idSelecionarServico`, manter a lista visível.
2. Clicar no item/radio do serviço BPC (id/value 1655) para que o site marque a opção (não só escrever).
3. Confirmar que o input (ou o estado interno do componente) reconheceu a seleção (valor simples, sem concatenação).
4. Só depois clicar em “Avançar” (#btn-next) para ir à próxima etapa (Dados Requerente).

## Fluxo atual vs. bug
- O script clica no item 1655 e reforça o valor do input, mas o campo fica com texto concatenado (nome + descrição + nome) e o site entende que não foi selecionado.
- Sintoma: mensagem de campo obrigatório ao avançar e log mostra valor duplicado no input.

## O que a IA deve descobrir
- Por que o clique no item 1655 não está efetivando a seleção (estado do combobox / rádio) mesmo com o texto preenchido.
- Como confirmar a seleção sem concatenar textos (capturar apenas o label principal do item).
- Como validar (pós-clique) que o componente considera a opção selecionada antes de avançar (ex.: checar radio.checked, atributo data-value ou similar). 
