# Acesso remoto no seu setup

O servidor funciona em localhost. Você escolhe a camada de acesso; não existe dependência obrigatória de Tailscale. Não compartilhe uma instância entre pessoas com níveis diferentes de confiança.

| Setup | Configuração do Cockpit | Responsabilidade externa |
|---|---|---|
| Apenas esta máquina | `HOST=127.0.0.1` | Nenhuma |
| VPN ou Tailscale com proxy local | Localhost + token | Publicar um endereço HTTPS restrito à sua rede |
| Reverse proxy próprio | Localhost + token | HTTPS, controle de acesso, preservação de Host e SSE sem buffering |
| Bind direto numa interface privada | IP da interface + token | Firewall/rede restrita e HTTPS direto |

Gere um token local e copie o resultado para `COCKPIT_TOKEN` no seu `.env`. Não compartilhe o resultado.

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

No navegador remoto, informe o token quando solicitado. O aplicativo pode gerar um link de acesso; esse link é uma credencial. Não o publique nem registre query strings no proxy, pois o EventSource transmite o token pela URL.

Para o proxy, encaminhe o tráfego para `http://127.0.0.1:7879`, preserve o `Host` original e não faça buffering de `text/event-stream`. Ajuste o timeout para manter conexões SSE e o limite de upload ao seu uso. O navegador e a API precisam usar a mesma origem; não habilite CORS como atalho.

Para HTTPS direto, defina caminhos absolutos em `COCKPIT_TLS_CERT` e `COCKPIT_TLS_KEY`. Um caminho explícito inválido impede o servidor de subir, em vez de cair silenciosamente para HTTP. O mecanismo antigo de certificados em `~/.cockpit/cert/servidor.crt` e `servidor.key` permanece por compatibilidade; instalações novas podem usar quaisquer nomes pelas variáveis.

As instruções para instalar sua VPN/proxy ficam com o fornecedor escolhido. Antes de liberar acesso, teste `/health`, a abertura de uma conversa e o recebimento de atualizações ao vivo. Leia [SECURITY.md](../SECURITY.md).
