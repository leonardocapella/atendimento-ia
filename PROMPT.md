Quero construir do zero um software de atendimento ao cliente com IA, open source e self-hosted, equivalente ao FabChat (fabchat.com.br), sem pagar nenhuma assinatura ou serviço. Use o gstack: comece com /office-hours e /plan-eng-review para validar o plano, implemente em fases e rode /review e /qa ao fim de cada fase. Fale comigo em português.

## Restrições
- Custo zero de software: só ferramentas gratuitas/open source e planos free.
- Stack sugerida (pode propor melhor, justificando): Next.js + TypeScript + Tailwind + shadcn/ui no painel; Node (Fastify ou NestJS) no backend; Postgres via Supabase (plano free) ou Postgres em Docker; Redis + BullMQ para filas e agendamentos; tudo em docker-compose.
- WhatsApp: duas formas de conexão, como o FabChat:
  1) QR Code (não oficial) via Evolution API ou Baileys self-hosted;
  2) API oficial (WhatsApp Cloud API da Meta), via webhook.
- Instagram: Direct e comentários pela Instagram Graph API (gratuita).
- IA plugável: provedor configurável no painel (qualquer API compatível com OpenAI/Anthropic, incluindo meu gateway local 9router em http://localhost:20128, Ollama local, Gemini ou Groq no plano free). Nada de chave fixa no código; segredos em .env, criptografados no banco.
- Multiempresa (multi-tenant) com login, papéis (admin, gestor, atendente) e isolamento de dados por empresa (RLS se usar Supabase).

## Funcionalidades (paridade com o FabChat)
1. Configuração do agente de IA em 4 etapas, tudo visual, sem código:
   - Comportamento e tom de voz: nome de apresentação, saudação, função, tom (formal a energético), idioma e fuso.
   - Regras, roteiro e limites: perguntas de qualificação feitas uma por vez, instruções prioritárias, regras de negócio, o que NÃO prometer sem validação, e quando transferir para humano (por funil e estágio, cliente insatisfeito, pergunta complexa).
   - Conhecimento e oferta: biografia da empresa, público-alvo, diferenciais, objetivo do agente, produtos/catálogo (incluindo upload de PDF com busca semântica/RAG via pgvector), pagamento, entrega, endereços e redes.
   - Horários e automação: horário por dia da semana, se responde fora do expediente, follow-up automático (intervalo e nº de tentativas, ex.: 1h, até 3), integração com Google Calendar para agendar, reagendar e lembrar antes da reunião.
   - Vários agentes por empresa (vendas, suporte, agendamento), cada um com personalidade própria, e um "playground" para testar o agente antes de ligar.
2. Inbox unificada: WhatsApp + Instagram no mesmo painel, com histórico, mídia (imagem, vídeo, áudio; transcrever áudio recebido), botão "assumir conversa" (pausa a IA) e "devolver para IA", notificações de transbordo.
3. Aprimorar mensagem com IA antes de enviar e resumir o atendimento em 1 clique.
4. CRM: funil de leads em kanban com estágios, tags, responsável, histórico de conversas; follow-up automático; recuperação de lead com sugestão de resposta.
5. Negociações: pipeline comercial com valores e etapas ligado ao lead.
6. Catálogo de produtos, serviços e planos (o agente responde preço e disponibilidade).
7. Automações por canal: fluxos por palavra-chave, primeiro contato, comentário ou story.
8. Agendar mensagens e mensagens de encerramento; disparo em massa com limites de velocidade e aviso de risco no modo QR.
9. Tarefas da equipe com urgência, metas e gamificação simples.
10. Dashboard: leads, conversas, desempenho por atendente, tarefas e horários de pico.

## Como entregar
- Antes de codar: me mostre a arquitetura, o modelo de dados e o plano em fases (MVP = WhatsApp por QR + agente configurável + inbox + transbordo humano; depois CRM, catálogo/RAG, Calendar, Instagram, automações, dashboard).
- Em cada fase: código, migrations, seeds de exemplo, testes do essencial, e README com como subir local (docker compose up) e em VPS.
- Segurança: valide webhooks, rate limit, logs sem dados sensíveis, nada de segredo commitado.
- Pare e me pergunte só em decisões que custem dinheiro ou sejam irreversíveis.
