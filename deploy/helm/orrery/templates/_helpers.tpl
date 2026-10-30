{{- define "orrery.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "orrery.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else if contains (include "orrery.name" .) .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name (include "orrery.name" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "orrery.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
app.kubernetes.io/name: {{ include "orrery.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: orrery
{{- end -}}

{{/* selector labels: (dict "ctx" $ "component" "api") */}}
{{- define "orrery.selector" -}}
app.kubernetes.io/name: {{ include "orrery.name" .ctx }}
app.kubernetes.io/instance: {{ .ctx.Release.Name }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{- define "orrery.image" -}}
{{- $tag := default .ctx.Chart.AppVersion .ctx.Values.image.tag -}}
{{- printf "%s/%s:%s" .ctx.Values.image.registry (index .ctx.Values.images .name) $tag -}}
{{- end -}}

{{/* Temporal frontend: the bundled server, or config.temporal.address. */}}
{{- define "orrery.temporalAddress" -}}
{{- if .Values.temporalServer.enabled -}}
{{- printf "%s-temporal.%s.svc:7233" (include "orrery.fullname" .) .Release.Namespace -}}
{{- else -}}
{{- required "config.temporal.address is required when temporalServer.enabled is false" .Values.config.temporal.address -}}
{{- end -}}
{{- end -}}

{{/* Public URL: explicit, else the ingress host, else the port-forward address. */}}
{{- define "orrery.publicBaseUrl" -}}
{{- if .Values.config.publicBaseUrl -}}
{{- .Values.config.publicBaseUrl | trimSuffix "/" -}}
{{- else if and .Values.ingress.enabled .Values.ingress.host -}}
{{- printf "%s://%s" (ternary "https" "http" .Values.ingress.tls.enabled) .Values.ingress.host -}}
{{- else -}}
http://localhost:8080
{{- end -}}
{{- end -}}

{{- define "orrery.secretName" -}}
{{- default (printf "%s-platform" (include "orrery.fullname" .)) .Values.secrets.existingSecret -}}
{{- end -}}

{{- define "orrery.configName" -}}
{{- printf "%s-config" (include "orrery.fullname" .) -}}
{{- end -}}

{{- define "orrery.apiService" -}}
{{- printf "%s-api" (include "orrery.fullname" .) -}}
{{- end -}}

{{- define "orrery.databaseUrlSecret" -}}
{{- if .Values.config.database.existingSecret -}}
name: {{ .Values.config.database.existingSecret }}
key: {{ .Values.config.database.existingSecretKey }}
{{- else -}}
name: {{ include "orrery.secretName" . }}
key: database-url
{{- end -}}
{{- end -}}

{{/* Env shared by API, workers and the migration job. */}}
{{- define "orrery.commonEnv" -}}
- name: DATABASE_URL
  valueFrom:
    secretKeyRef:
      {{- include "orrery.databaseUrlSecret" . | nindent 6 }}
- name: MCP_TOKEN_SECRET
  valueFrom: { secretKeyRef: { name: {{ include "orrery.secretName" . }}, key: mcp-token-secret } }
- name: GATEWAY_TOKEN_SECRET
  valueFrom: { secretKeyRef: { name: {{ include "orrery.secretName" . }}, key: gateway-token-secret } }
- name: ENCRYPTION_KEY
  valueFrom: { secretKeyRef: { name: {{ include "orrery.secretName" . }}, key: encryption-key } }
{{- if or .Values.config.langfuse.existingSecret .Values.config.langfuse.publicKey }}
- name: LANGFUSE_PUBLIC_KEY
  valueFrom: { secretKeyRef: { name: {{ default (include "orrery.secretName" .) .Values.config.langfuse.existingSecret }}, key: {{ ternary "public-key" "langfuse-public-key" (ne .Values.config.langfuse.existingSecret "") }} } }
- name: LANGFUSE_SECRET_KEY
  valueFrom: { secretKeyRef: { name: {{ default (include "orrery.secretName" .) .Values.config.langfuse.existingSecret }}, key: {{ ternary "secret-key" "langfuse-secret-key" (ne .Values.config.langfuse.existingSecret "") }} } }
{{- end }}
{{- if .Values.config.adminToken.enabled }}
- name: ADMIN_TOKEN
  valueFrom: { secretKeyRef: { name: {{ include "orrery.secretName" . }}, key: admin-token } }
{{- end }}
{{- if .Values.config.devAuthToken }}
- name: DEV_AUTH_TOKEN
  valueFrom: { secretKeyRef: { name: {{ include "orrery.secretName" . }}, key: dev-auth-token } }
{{- end }}
{{- if .Values.config.temporal.apiKeySecret }}
- name: TEMPORAL_API_KEY
  valueFrom: { secretKeyRef: { name: {{ .Values.config.temporal.apiKeySecret }}, key: {{ .Values.config.temporal.apiKeySecretKey }} } }
{{- end }}
{{- if .Values.config.temporal.tlsSecret }}
- name: TEMPORAL_TLS
  value: "true"
- name: TEMPORAL_TLS_CERT_PATH
  value: /etc/orrery/temporal-tls/tls.crt
- name: TEMPORAL_TLS_KEY_PATH
  value: /etc/orrery/temporal-tls/tls.key
{{- end }}
{{- range .Values.config.extraEnv }}
- {{ toYaml . | nindent 2 | trim }}
{{- end }}
{{- end -}}

{{- define "orrery.envFrom" -}}
- configMapRef:
    name: {{ include "orrery.configName" . }}
{{- if .Values.config.providerSecret }}
- secretRef:
    name: {{ .Values.config.providerSecret }}
{{- end }}
{{- end -}}

{{- define "orrery.commonVolumes" -}}
- name: tmp
  emptyDir: {}
- name: config
  configMap:
    name: {{ include "orrery.configName" . }}
    items:
      - key: providers.yaml
        path: providers.yaml
{{- if .Values.config.temporal.tlsSecret }}
- name: temporal-tls
  secret:
    secretName: {{ .Values.config.temporal.tlsSecret }}
{{- end }}
{{- end -}}

{{- define "orrery.commonMounts" -}}
- name: tmp
  mountPath: /tmp
- name: config
  mountPath: /etc/orrery/config
  readOnly: true
{{- if .Values.config.temporal.tlsSecret }}
- name: temporal-tls
  mountPath: /etc/orrery/temporal-tls
  readOnly: true
{{- end }}
{{- end -}}

{{- define "orrery.computerNamespace" -}}
{{- .Values.computers.namespace -}}
{{- end -}}

{{/* Stable password for the bundled trial Postgres (kept across upgrades). */}}
{{- define "orrery.postgresPassword" -}}
{{- if .Values.postgresql.password -}}
{{- .Values.postgresql.password -}}
{{- else -}}
{{- $s := (lookup "v1" "Secret" .Release.Namespace (printf "%s-postgresql" (include "orrery.fullname" .))) | default dict -}}
{{- $d := (get $s "data") | default dict -}}
{{- if hasKey $d "password" -}}
{{- index $d "password" | b64dec -}}
{{- else -}}
{{- $_ := set .Values.postgresql "password" (randAlphaNum 32) -}}
{{- .Values.postgresql.password -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{/*
Platform secret values: reused from the live Secret on upgrades, generated once per render
otherwise (cached so every template sees the same value). Returns the base64 value.
Usage: include "orrery.platformSecret" (dict "ctx" $ "key" "gateway-token-secret" "gen" (randAlphaNum 48))
*/}}
{{- define "orrery.platformSecret" -}}
{{- $ctx := .ctx -}}
{{- $cache := $ctx.Values._generated | default dict -}}
{{- if not (hasKey $cache .key) -}}
{{- $name := include "orrery.secretName" $ctx -}}
{{- $existing := (lookup "v1" "Secret" $ctx.Release.Namespace $name) | default dict -}}
{{- $data := (get $existing "data") | default dict -}}
{{- $_ := set $cache .key (get $data .key | default (.gen | b64enc)) -}}
{{- $_ := set $ctx.Values "_generated" $cache -}}
{{- end -}}
{{- get $cache .key -}}
{{- end -}}

{{/* Comma-separated names from an imagePullSecrets list ([{name: regcred}]). */}}
{{- define "orrery.pullSecretNames" -}}
{{- $names := list -}}
{{- range . }}{{ $names = append $names .name }}{{ end -}}
{{- join "," $names -}}
{{- end -}}
