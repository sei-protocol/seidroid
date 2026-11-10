{{- define "seidroid.selectorLabels" -}}
app.kubernetes.io/name: {{ .Chart.Name }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{- define "seidroid.labels" -}}
{{ include "seidroid.selectorLabels" . }}
app.kubernetes.io/version: {{ .Values.image.tag | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{- end }}

{{- define "seidroid.image" -}}
{{- $tag := required "image.tag is required" .Values.image.tag -}}
{{- if .Values.image.digest -}}
{{ printf "%s:%s@%s" .Values.image.repository $tag .Values.image.digest }}
{{- else -}}
{{ printf "%s:%s" .Values.image.repository $tag }}
{{- end -}}
{{- end }}
