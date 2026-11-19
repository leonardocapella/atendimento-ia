# Teste no GitHub Codespaces (pt-BR)

Ambiente de **teste**. Use só um número de WhatsApp de teste no QR, nunca o da EBM. Nada aqui é produção (produção: `docs/DEPLOY.md`).

## Uma vez

1. Secret do Codespaces `GEMINI_API_KEY` (github.com/settings/codespaces), liberado para este repositório.
2. Crie o Codespace (Code > Codespaces). 2 núcleos bastam. Timeout de inatividade de 30 min economiza horas.

## Subir

```bash
bash scripts/codespace-up.sh
```

O script, sem cliques:

- gera o `.env` a partir do `.env.example` com segredos aleatórios em hex e o Gemini (`gemini-2.5-flash`, endpoint OpenAI-compatível do Google, chave do secret);
- sobe Postgres, Redis, Chatwoot (com migrations), Sidekiq, app (api + worker) e Evolution. Sem Caddy;
- cria no Chatwoot a conta 1, o admin de teste (usuário 1), o "Lorenzo (teste)" (usuário 2), o Agent Bot e o webhook da conta apontando para o app, e grava os tokens no `.env`;
- cria a instância Evolution `teste`, liga a integração com o Chatwoot (cria a inbox "WhatsApp Teste") e coloca o Agent Bot nessa inbox;
- salva o QR em `qr.png` e as senhas em `.codespace-credenciais.txt` (os dois fora do git).

Quando o Codespace acorda, o `postStartCommand` religa os containers.

## Portas

| Porta | O quê |
|---|---|
| 3000 | Chatwoot (login do admin de teste) |
| 8080 | Evolution. QR em `/manager` (Server URL = a própria URL da porta, API Key = `EVOLUTION_API_KEY` do arquivo de credenciais) |
| 8081 | Painel do app (login com o token de acesso do Chatwoot) |

Porta privada só abre para o dono do Codespace logado no GitHub. Para outra pessoa abrir, torne pública só a porta necessária.

## Testar

1. Abra o `/manager` da porta 8080, entre na instância `teste` e leia o QR com o celular de teste (WhatsApp > Aparelhos conectados).
2. De outro celular, mande mensagem para o número de teste. A conversa aparece no Chatwoot e a Malu responde.
3. Peça orçamento com medidas, prazo e cidade: a conversa vai para o "Lorenzo (teste)" com uma nota.

Desligue o Codespace quando terminar (Stop codespace) para não gastar horas.
