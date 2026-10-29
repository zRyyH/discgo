// Package storage pre-signs S3 URLs for attachments (PLAN 3.1 step 7): the
// client uploads straight to the bucket; the API never sees file bytes.
package storage

import (
	"context"
	"errors"
	"fmt"
	"path"
	"strings"
	"time"
	"unicode"

	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/google/uuid"
)

// GetTTL is the lifetime of download URLs; 7 days is the SigV4 maximum.
const (
	GetTTL = 7 * 24 * time.Hour
	PutTTL = 15 * time.Minute
)

type Config struct {
	Region       string
	Bucket       string
	Endpoint     string // MinIO in dev; empty for AWS
	CreateBucket bool
}

type Store struct {
	bucket  string
	client  *s3.Client
	presign *s3.PresignClient
}

func New(ctx context.Context, cfg Config) (*Store, error) {
	if cfg.Bucket == "" {
		return nil, errors.New("S3_BUCKET is required")
	}
	awsCfg, err := awsconfig.LoadDefaultConfig(ctx, awsconfig.WithRegion(cfg.Region))
	if err != nil {
		return nil, err
	}
	client := s3.NewFromConfig(awsCfg, func(o *s3.Options) {
		if cfg.Endpoint != "" {
			o.BaseEndpoint = aws.String(cfg.Endpoint)
			o.UsePathStyle = true
		}
	})
	if cfg.CreateBucket {
		if _, err := client.HeadBucket(ctx, &s3.HeadBucketInput{Bucket: &cfg.Bucket}); err != nil {
			if _, err := client.CreateBucket(ctx, &s3.CreateBucketInput{Bucket: &cfg.Bucket}); err != nil {
				return nil, fmt.Errorf("create bucket: %w", err)
			}
		}
	}
	return &Store{bucket: cfg.Bucket, client: client, presign: s3.NewPresignClient(client)}, nil
}

// KeyPrefix is where a user's uploads live; message attachments must be under it.
func KeyPrefix(userID uuid.UUID) string {
	return "att/" + userID.String() + "/"
}

// PresignPut returns the key and a URL the client PUTs the file to, with the
// given Content-Type and exact Content-Length.
func (s *Store) PresignPut(ctx context.Context, userID uuid.UUID, name, contentType string, size int64) (string, string, error) {
	key := KeyPrefix(userID) + uuid.Must(uuid.NewV7()).String() + "/" + safeName(name)
	req, err := s.presign.PresignPutObject(ctx, &s3.PutObjectInput{
		Bucket:        &s.bucket,
		Key:           &key,
		ContentType:   &contentType,
		ContentLength: &size,
	}, s3.WithPresignExpires(PutTTL))
	if err != nil {
		return "", "", err
	}
	return key, req.URL, nil
}

// PresignGet returns a download URL; images open inline, other files download.
func (s *Store) PresignGet(key string) string {
	disposition := "attachment"
	if ext := strings.ToLower(path.Ext(key)); ext == ".png" || ext == ".jpg" || ext == ".jpeg" || ext == ".gif" || ext == ".webp" {
		disposition = "inline"
	}
	req, err := s.presign.PresignGetObject(context.Background(), &s3.GetObjectInput{
		Bucket:                     &s.bucket,
		Key:                        &key,
		ResponseContentDisposition: aws.String(disposition),
	}, s3.WithPresignExpires(GetTTL))
	if err != nil {
		return ""
	}
	return req.URL
}

// safeName keeps file names readable in URLs and S3 keys.
func safeName(name string) string {
	name = path.Base(strings.ReplaceAll(name, "\\", "/"))
	var b strings.Builder
	for _, r := range name {
		switch {
		case unicode.IsLetter(r) || unicode.IsDigit(r) || r == '.' || r == '-' || r == '_':
			b.WriteRune(r)
		case r == ' ':
			b.WriteRune('_')
		}
	}
	out := b.String()
	if out == "" || out == "." || out == ".." {
		out = "file"
	}
	if len(out) > 120 {
		out = out[len(out)-120:]
	}
	return out
}
