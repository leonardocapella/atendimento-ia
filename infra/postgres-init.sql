-- Executado só na 1ª subida do volume. O Chatwoot usa o banco "chatwoot"; o app usa "brain".
CREATE DATABASE brain;
\c brain
CREATE EXTENSION IF NOT EXISTS vector;
\c chatwoot
CREATE EXTENSION IF NOT EXISTS vector;
