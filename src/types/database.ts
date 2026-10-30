export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.18"
  }
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      account_eligibilities: {
        Row: {
          archived_at: string | null
          chain_id: string
          created_at: string
          household_id: string
          id: string
          memo: string
          requirement_id: string
          service_account_id: string
          state: string
          updated_at: string
          updated_by_profile_id: string | null
          valid_from: string | null
          valid_until: string | null
          verified_on: string | null
        }
        Insert: {
          archived_at?: string | null
          chain_id: string
          created_at?: string
          household_id: string
          id?: string
          memo?: string
          requirement_id: string
          service_account_id: string
          state?: string
          updated_at?: string
          updated_by_profile_id?: string | null
          valid_from?: string | null
          valid_until?: string | null
          verified_on?: string | null
        }
        Update: {
          archived_at?: string | null
          chain_id?: string
          created_at?: string
          household_id?: string
          id?: string
          memo?: string
          requirement_id?: string
          service_account_id?: string
          state?: string
          updated_at?: string
          updated_by_profile_id?: string | null
          valid_from?: string | null
          valid_until?: string | null
          verified_on?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "account_eligibilities_household_id_fkey"
            columns: ["household_id"]
            isOneToOne: false
            referencedRelation: "households"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "account_eligibilities_requirement_id_chain_id_household_id_fkey"
            columns: ["requirement_id", "chain_id", "household_id"]
            isOneToOne: false
            referencedRelation: "chain_requirements"
            referencedColumns: ["id", "chain_id", "household_id"]
          },
          {
            foreignKeyName: "account_eligibilities_service_account_id_chain_id_househol_fkey"
            columns: ["service_account_id", "chain_id", "household_id"]
            isOneToOne: false
            referencedRelation: "service_accounts"
            referencedColumns: ["id", "chain_id", "household_id"]
          },
          {
            foreignKeyName: "account_eligibilities_updated_by_profile_id_household_id_fkey"
            columns: ["updated_by_profile_id", "household_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id", "household_id"]
          },
        ]
      }
      address_groups: {
        Row: {
          archived_at: string | null
          created_at: string
          household_id: string
          id: string
          label: string
          updated_at: string
          updated_by_profile_id: string | null
        }
        Insert: {
          archived_at?: string | null
          created_at?: string
          household_id: string
          id?: string
          label: string
          updated_at?: string
          updated_by_profile_id?: string | null
        }
        Update: {
          archived_at?: string | null
          created_at?: string
          household_id?: string
          id?: string
          label?: string
          updated_at?: string
          updated_by_profile_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "address_groups_household_id_fkey"
            columns: ["household_id"]
            isOneToOne: false
            referencedRelation: "households"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "address_groups_updated_by_profile_id_household_id_fkey"
            columns: ["updated_by_profile_id", "household_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id", "household_id"]
          },
        ]
      }
      ai_extraction_feedback: {
        Row: {
          adopted_count: number
          created_at: string
          engine: string
          explicit_error_count: number
          field_results: Json
          finalized_by_profile_id: string | null
          household_id: string
          id: string
          kind: string
          lottery_id: string
          model: string | null
          modified_count: number
          normalized_count: number
          prompt_version: string | null
          reason: string | null
          run_id: string
          supplemented_count: number
        }
        Insert: {
          adopted_count?: number
          created_at?: string
          engine: string
          explicit_error_count?: number
          field_results: Json
          finalized_by_profile_id?: string | null
          household_id: string
          id?: string
          kind: string
          lottery_id: string
          model?: string | null
          modified_count?: number
          normalized_count?: number
          prompt_version?: string | null
          reason?: string | null
          run_id: string
          supplemented_count?: number
        }
        Update: {
          adopted_count?: number
          created_at?: string
          engine?: string
          explicit_error_count?: number
          field_results?: Json
          finalized_by_profile_id?: string | null
          household_id?: string
          id?: string
          kind?: string
          lottery_id?: string
          model?: string | null
          modified_count?: number
          normalized_count?: number
          prompt_version?: string | null
          reason?: string | null
          run_id?: string
          supplemented_count?: number
        }
        Relationships: [
          {
            foreignKeyName: "ai_extraction_feedback_finalized_by_profile_id_household_i_fkey"
            columns: ["finalized_by_profile_id", "household_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id", "household_id"]
          },
          {
            foreignKeyName: "ai_extraction_feedback_household_id_fkey"
            columns: ["household_id"]
            isOneToOne: false
            referencedRelation: "households"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_extraction_feedback_lottery_id_household_id_fkey"
            columns: ["lottery_id", "household_id"]
            isOneToOne: false
            referencedRelation: "lotteries"
            referencedColumns: ["id", "household_id"]
          },
          {
            foreignKeyName: "ai_extraction_feedback_run_id_household_id_fkey"
            columns: ["run_id", "household_id"]
            isOneToOne: false
            referencedRelation: "ai_extraction_logs"
            referencedColumns: ["id", "household_id"]
          },
        ]
      }
      ai_extraction_logs: {
        Row: {
          created_at: string
          engine: string
          extraction: Json | null
          household_id: string
          id: string
          input_tokens: number | null
          kind: string
          model: string | null
          output_tokens: number | null
          prompt_version: string | null
          source_host: string | null
          status: string
          user_id: string
        }
        Insert: {
          created_at?: string
          engine: string
          extraction?: Json | null
          household_id: string
          id?: string
          input_tokens?: number | null
          kind: string
          model?: string | null
          output_tokens?: number | null
          prompt_version?: string | null
          source_host?: string | null
          status: string
          user_id?: string
        }
        Update: {
          created_at?: string
          engine?: string
          extraction?: Json | null
          household_id?: string
          id?: string
          input_tokens?: number | null
          kind?: string
          model?: string | null
          output_tokens?: number | null
          prompt_version?: string | null
          source_host?: string | null
          status?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "ai_extraction_logs_household_id_fkey"
            columns: ["household_id"]
            isOneToOne: false
            referencedRelation: "households"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_job_items: {
        Row: {
          attempts: number
          created_at: string
          dedupe_key: string | null
          error_code: string | null
          error_message: string | null
          finished_at: string | null
          household_id: string
          id: string
          image_paths: string[]
          job_id: string
          lease_until: string | null
          lottery_id: string | null
          position: number
          result: Json | null
          run_id: string | null
          source_kind: string
          source_text: string | null
          source_url: string | null
          started_at: string | null
          status: string
          updated_at: string
        }
        Insert: {
          attempts?: number
          created_at?: string
          dedupe_key?: string | null
          error_code?: string | null
          error_message?: string | null
          finished_at?: string | null
          household_id: string
          id?: string
          image_paths?: string[]
          job_id: string
          lease_until?: string | null
          lottery_id?: string | null
          position?: number
          result?: Json | null
          run_id?: string | null
          source_kind: string
          source_text?: string | null
          source_url?: string | null
          started_at?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          attempts?: number
          created_at?: string
          dedupe_key?: string | null
          error_code?: string | null
          error_message?: string | null
          finished_at?: string | null
          household_id?: string
          id?: string
          image_paths?: string[]
          job_id?: string
          lease_until?: string | null
          lottery_id?: string | null
          position?: number
          result?: Json | null
          run_id?: string | null
          source_kind?: string
          source_text?: string | null
          source_url?: string | null
          started_at?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "ai_job_items_household_id_fkey"
            columns: ["household_id"]
            isOneToOne: false
            referencedRelation: "households"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ai_job_items_job_id_household_id_fkey"
            columns: ["job_id", "household_id"]
            isOneToOne: false
            referencedRelation: "ai_jobs"
            referencedColumns: ["id", "household_id"]
          },
          {
            foreignKeyName: "ai_job_items_lottery_id_household_id_fkey"
            columns: ["lottery_id", "household_id"]
            isOneToOne: false
            referencedRelation: "lotteries"
            referencedColumns: ["id", "household_id"]
          },
          {
            foreignKeyName: "ai_job_items_run_id_household_id_fkey"
            columns: ["run_id", "household_id"]
            isOneToOne: false
            referencedRelation: "ai_extraction_logs"
            referencedColumns: ["id", "household_id"]
          },
        ]
      }
      ai_jobs: {
        Row: {
          completed_at: string | null
          created_at: string
          created_by_profile_id: string | null
          household_id: string
          id: string
          label: string
          seen_at: string | null
          status: string
          total_items: number
          updated_at: string
        }
        Insert: {
          completed_at?: string | null
          created_at?: string
          created_by_profile_id?: string | null
          household_id: string
          id?: string
          label?: string
          seen_at?: string | null
          status?: string
          total_items?: number
          updated_at?: string
        }
        Update: {
          completed_at?: string | null
          created_at?: string
          created_by_profile_id?: string | null
          household_id?: string
          id?: string
          label?: string
          seen_at?: string | null
          status?: string
          total_items?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "ai_jobs_created_by_profile_id_household_id_fkey"
            columns: ["created_by_profile_id", "household_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id", "household_id"]
          },
          {
            foreignKeyName: "ai_jobs_household_id_fkey"
            columns: ["household_id"]
            isOneToOne: false
            referencedRelation: "households"
            referencedColumns: ["id"]
          },
        ]
      }
      application_item_results: {
        Row: {
          application_id: string
          created_at: string
          household_id: string
          id: string
          lottery_item_id: string
          result_status: string
          updated_at: string
          updated_by_profile_id: string | null
        }
        Insert: {
          application_id: string
          created_at?: string
          household_id: string
          id?: string
          lottery_item_id: string
          result_status?: string
          updated_at?: string
          updated_by_profile_id?: string | null
        }
        Update: {
          application_id?: string
          created_at?: string
          household_id?: string
          id?: string
          lottery_item_id?: string
          result_status?: string
          updated_at?: string
          updated_by_profile_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "application_item_results_application_id_household_id_fkey"
            columns: ["application_id", "household_id"]
            isOneToOne: false
            referencedRelation: "applications"
            referencedColumns: ["id", "household_id"]
          },
          {
            foreignKeyName: "application_item_results_household_id_fkey"
            columns: ["household_id"]
            isOneToOne: false
            referencedRelation: "households"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "application_item_results_lottery_item_id_household_id_fkey"
            columns: ["lottery_item_id", "household_id"]
            isOneToOne: false
            referencedRelation: "lottery_items"
            referencedColumns: ["id", "household_id"]
          },
          {
            foreignKeyName: "application_item_results_updated_by_profile_id_household_i_fkey"
            columns: ["updated_by_profile_id", "household_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id", "household_id"]
          },
        ]
      }
      application_rules: {
        Row: {
          basis: string
          campaign_id: string | null
          chain_id: string | null
          confidence: string
          counts_across: string
          created_at: string
          household_id: string
          id: string
          lottery_id: string | null
          max_count: number
          memo: string
          scope_type: string
          updated_at: string
          updated_by_profile_id: string | null
        }
        Insert: {
          basis: string
          campaign_id?: string | null
          chain_id?: string | null
          confidence?: string
          counts_across?: string
          created_at?: string
          household_id: string
          id?: string
          lottery_id?: string | null
          max_count?: number
          memo?: string
          scope_type: string
          updated_at?: string
          updated_by_profile_id?: string | null
        }
        Update: {
          basis?: string
          campaign_id?: string | null
          chain_id?: string | null
          confidence?: string
          counts_across?: string
          created_at?: string
          household_id?: string
          id?: string
          lottery_id?: string | null
          max_count?: number
          memo?: string
          scope_type?: string
          updated_at?: string
          updated_by_profile_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "application_rules_campaign_id_household_id_fkey"
            columns: ["campaign_id", "household_id"]
            isOneToOne: false
            referencedRelation: "campaigns"
            referencedColumns: ["id", "household_id"]
          },
          {
            foreignKeyName: "application_rules_chain_id_household_id_fkey"
            columns: ["chain_id", "household_id"]
            isOneToOne: false
            referencedRelation: "chains"
            referencedColumns: ["id", "household_id"]
          },
          {
            foreignKeyName: "application_rules_household_id_fkey"
            columns: ["household_id"]
            isOneToOne: false
            referencedRelation: "households"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "application_rules_lottery_id_household_id_fkey"
            columns: ["lottery_id", "household_id"]
            isOneToOne: false
            referencedRelation: "lotteries"
            referencedColumns: ["id", "household_id"]
          },
          {
            foreignKeyName: "application_rules_updated_by_profile_id_household_id_fkey"
            columns: ["updated_by_profile_id", "household_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id", "household_id"]
          },
        ]
      }
      applications: {
        Row: {
          applied_at: string | null
          created_at: string
          fulfillment_status: string
          household_id: string
          id: string
          lottery_id: string
          origin: string
          procedure_completed_at: string | null
          result_confirmed_at: string | null
          result_status: string
          selected_item_id: string | null
          service_account_id: string
          state: string
          updated_at: string
          updated_by_profile_id: string | null
        }
        Insert: {
          applied_at?: string | null
          created_at?: string
          fulfillment_status?: string
          household_id: string
          id?: string
          lottery_id: string
          origin?: string
          procedure_completed_at?: string | null
          result_confirmed_at?: string | null
          result_status?: string
          selected_item_id?: string | null
          service_account_id: string
          state?: string
          updated_at?: string
          updated_by_profile_id?: string | null
        }
        Update: {
          applied_at?: string | null
          created_at?: string
          fulfillment_status?: string
          household_id?: string
          id?: string
          lottery_id?: string
          origin?: string
          procedure_completed_at?: string | null
          result_confirmed_at?: string | null
          result_status?: string
          selected_item_id?: string | null
          service_account_id?: string
          state?: string
          updated_at?: string
          updated_by_profile_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "applications_household_id_fkey"
            columns: ["household_id"]
            isOneToOne: false
            referencedRelation: "households"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "applications_lottery_id_household_id_fkey"
            columns: ["lottery_id", "household_id"]
            isOneToOne: false
            referencedRelation: "lotteries"
            referencedColumns: ["id", "household_id"]
          },
          {
            foreignKeyName: "applications_selected_item_id_household_id_fkey"
            columns: ["selected_item_id", "household_id"]
            isOneToOne: false
            referencedRelation: "lottery_items"
            referencedColumns: ["id", "household_id"]
          },
          {
            foreignKeyName: "applications_service_account_id_household_id_fkey"
            columns: ["service_account_id", "household_id"]
            isOneToOne: false
            referencedRelation: "service_accounts"
            referencedColumns: ["id", "household_id"]
          },
          {
            foreignKeyName: "applications_updated_by_profile_id_household_id_fkey"
            columns: ["updated_by_profile_id", "household_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id", "household_id"]
          },
        ]
      }
      audit_logs: {
        Row: {
          action: string
          actor_auth_user_id: string | null
          actor_profile_id: string | null
          after_json: Json | null
          before_json: Json | null
          entity_id: string | null
          entity_type: string
          household_id: string
          id: string
          occurred_at: string
        }
        Insert: {
          action: string
          actor_auth_user_id?: string | null
          actor_profile_id?: string | null
          after_json?: Json | null
          before_json?: Json | null
          entity_id?: string | null
          entity_type: string
          household_id: string
          id?: string
          occurred_at?: string
        }
        Update: {
          action?: string
          actor_auth_user_id?: string | null
          actor_profile_id?: string | null
          after_json?: Json | null
          before_json?: Json | null
          entity_id?: string | null
          entity_type?: string
          household_id?: string
          id?: string
          occurred_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "audit_logs_actor_profile_id_household_id_fkey"
            columns: ["actor_profile_id", "household_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id", "household_id"]
          },
          {
            foreignKeyName: "audit_logs_household_id_fkey"
            columns: ["household_id"]
            isOneToOne: false
            referencedRelation: "households"
            referencedColumns: ["id"]
          },
        ]
      }
      battle_records: {
        Row: {
          archived_at: string | null
          created_at: string
          format: string
          household_id: string
          id: string
          memo: string
          my_deck: string
          opponent: string
          opponent_deck: string
          played_on: string
          profile_id: string | null
          result: string
          turn_order: string
          updated_at: string
          updated_by_profile_id: string | null
        }
        Insert: {
          archived_at?: string | null
          created_at?: string
          format?: string
          household_id: string
          id?: string
          memo?: string
          my_deck?: string
          opponent?: string
          opponent_deck?: string
          played_on: string
          profile_id?: string | null
          result: string
          turn_order?: string
          updated_at?: string
          updated_by_profile_id?: string | null
        }
        Update: {
          archived_at?: string | null
          created_at?: string
          format?: string
          household_id?: string
          id?: string
          memo?: string
          my_deck?: string
          opponent?: string
          opponent_deck?: string
          played_on?: string
          profile_id?: string | null
          result?: string
          turn_order?: string
          updated_at?: string
          updated_by_profile_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "battle_records_household_id_fkey"
            columns: ["household_id"]
            isOneToOne: false
            referencedRelation: "households"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "battle_records_profile_id_household_id_fkey"
            columns: ["profile_id", "household_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id", "household_id"]
          },
          {
            foreignKeyName: "battle_records_updated_by_profile_id_household_id_fkey"
            columns: ["updated_by_profile_id", "household_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id", "household_id"]
          },
        ]
      }
      campaigns: {
        Row: {
          chain_id: string
          created_at: string
          household_id: string
          id: string
          name: string
          store_rule: string
          updated_at: string
          updated_by_profile_id: string | null
        }
        Insert: {
          chain_id: string
          created_at?: string
          household_id: string
          id?: string
          name: string
          store_rule?: string
          updated_at?: string
          updated_by_profile_id?: string | null
        }
        Update: {
          chain_id?: string
          created_at?: string
          household_id?: string
          id?: string
          name?: string
          store_rule?: string
          updated_at?: string
          updated_by_profile_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "campaigns_chain_id_household_id_fkey"
            columns: ["chain_id", "household_id"]
            isOneToOne: false
            referencedRelation: "chains"
            referencedColumns: ["id", "household_id"]
          },
          {
            foreignKeyName: "campaigns_household_id_fkey"
            columns: ["household_id"]
            isOneToOne: false
            referencedRelation: "households"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "campaigns_updated_by_profile_id_household_id_fkey"
            columns: ["updated_by_profile_id", "household_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id", "household_id"]
          },
        ]
      }
      card_favorites: {
        Row: {
          card_id: string
          created_at: string
          household_id: string
          id: string
          profile_id: string
          rank: number
          updated_at: string
        }
        Insert: {
          card_id: string
          created_at?: string
          household_id: string
          id?: string
          profile_id: string
          rank?: number
          updated_at?: string
        }
        Update: {
          card_id?: string
          created_at?: string
          household_id?: string
          id?: string
          profile_id?: string
          rank?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "card_favorites_card_id_household_id_fkey"
            columns: ["card_id", "household_id"]
            isOneToOne: false
            referencedRelation: "card_masters"
            referencedColumns: ["id", "household_id"]
          },
          {
            foreignKeyName: "card_favorites_household_id_fkey"
            columns: ["household_id"]
            isOneToOne: false
            referencedRelation: "households"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "card_favorites_profile_id_household_id_fkey"
            columns: ["profile_id", "household_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id", "household_id"]
          },
        ]
      }
      card_holdings: {
        Row: {
          acquired_on: string | null
          archived_at: string | null
          card_id: string
          condition: string
          created_at: string
          household_id: string
          id: string
          note: string
          purchase_id: string | null
          quantity: number
          source: string
          unit_price_yen: number | null
          updated_at: string
          updated_by_profile_id: string | null
        }
        Insert: {
          acquired_on?: string | null
          archived_at?: string | null
          card_id: string
          condition?: string
          created_at?: string
          household_id: string
          id?: string
          note?: string
          purchase_id?: string | null
          quantity: number
          source?: string
          unit_price_yen?: number | null
          updated_at?: string
          updated_by_profile_id?: string | null
        }
        Update: {
          acquired_on?: string | null
          archived_at?: string | null
          card_id?: string
          condition?: string
          created_at?: string
          household_id?: string
          id?: string
          note?: string
          purchase_id?: string | null
          quantity?: number
          source?: string
          unit_price_yen?: number | null
          updated_at?: string
          updated_by_profile_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "card_holdings_card_id_household_id_fkey"
            columns: ["card_id", "household_id"]
            isOneToOne: false
            referencedRelation: "card_masters"
            referencedColumns: ["id", "household_id"]
          },
          {
            foreignKeyName: "card_holdings_household_id_fkey"
            columns: ["household_id"]
            isOneToOne: false
            referencedRelation: "households"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "card_holdings_purchase_id_household_id_fkey"
            columns: ["purchase_id", "household_id"]
            isOneToOne: false
            referencedRelation: "purchases"
            referencedColumns: ["id", "household_id"]
          },
          {
            foreignKeyName: "card_holdings_updated_by_profile_id_household_id_fkey"
            columns: ["updated_by_profile_id", "household_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id", "household_id"]
          },
        ]
      }
      card_masters: {
        Row: {
          analysis_run_id: string | null
          archived_at: string | null
          card_number: string
          card_type: string
          created_at: string
          household_id: string
          id: string
          image_path: string | null
          image_sha256: string | null
          name: string
          product_id: string | null
          product_name: string
          rarity: string
          set_code: string
          source_url: string | null
          updated_at: string
          updated_by_profile_id: string | null
        }
        Insert: {
          analysis_run_id?: string | null
          archived_at?: string | null
          card_number?: string
          card_type?: string
          created_at?: string
          household_id: string
          id?: string
          image_path?: string | null
          image_sha256?: string | null
          name: string
          product_id?: string | null
          product_name?: string
          rarity?: string
          set_code?: string
          source_url?: string | null
          updated_at?: string
          updated_by_profile_id?: string | null
        }
        Update: {
          analysis_run_id?: string | null
          archived_at?: string | null
          card_number?: string
          card_type?: string
          created_at?: string
          household_id?: string
          id?: string
          image_path?: string | null
          image_sha256?: string | null
          name?: string
          product_id?: string | null
          product_name?: string
          rarity?: string
          set_code?: string
          source_url?: string | null
          updated_at?: string
          updated_by_profile_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "card_masters_analysis_run_id_household_id_fkey"
            columns: ["analysis_run_id", "household_id"]
            isOneToOne: false
            referencedRelation: "ai_extraction_logs"
            referencedColumns: ["id", "household_id"]
          },
          {
            foreignKeyName: "card_masters_household_id_fkey"
            columns: ["household_id"]
            isOneToOne: false
            referencedRelation: "households"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "card_masters_product_id_household_id_fkey"
            columns: ["product_id", "household_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id", "household_id"]
          },
          {
            foreignKeyName: "card_masters_updated_by_profile_id_household_id_fkey"
            columns: ["updated_by_profile_id", "household_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id", "household_id"]
          },
        ]
      }
      card_prices: {
        Row: {
          amount_yen: number
          card_id: string
          confirmed_on: string
          created_at: string
          household_id: string
          id: string
          kind: string
          source: string
          source_url: string | null
          updated_by_profile_id: string | null
        }
        Insert: {
          amount_yen: number
          card_id: string
          confirmed_on?: string
          created_at?: string
          household_id: string
          id?: string
          kind: string
          source?: string
          source_url?: string | null
          updated_by_profile_id?: string | null
        }
        Update: {
          amount_yen?: number
          card_id?: string
          confirmed_on?: string
          created_at?: string
          household_id?: string
          id?: string
          kind?: string
          source?: string
          source_url?: string | null
          updated_by_profile_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "card_prices_card_id_household_id_fkey"
            columns: ["card_id", "household_id"]
            isOneToOne: false
            referencedRelation: "card_masters"
            referencedColumns: ["id", "household_id"]
          },
          {
            foreignKeyName: "card_prices_household_id_fkey"
            columns: ["household_id"]
            isOneToOne: false
            referencedRelation: "households"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "card_prices_updated_by_profile_id_household_id_fkey"
            columns: ["updated_by_profile_id", "household_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id", "household_id"]
          },
        ]
      }
      chain_aliases: {
        Row: {
          alias: string
          chain_id: string
          created_at: string
          household_id: string
          id: string
          normalized_alias: string
          updated_at: string
          updated_by_profile_id: string | null
        }
        Insert: {
          alias: string
          chain_id: string
          created_at?: string
          household_id: string
          id?: string
          normalized_alias: string
          updated_at?: string
          updated_by_profile_id?: string | null
        }
        Update: {
          alias?: string
          chain_id?: string
          created_at?: string
          household_id?: string
          id?: string
          normalized_alias?: string
          updated_at?: string
          updated_by_profile_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "chain_aliases_chain_id_household_id_fkey"
            columns: ["chain_id", "household_id"]
            isOneToOne: false
            referencedRelation: "chains"
            referencedColumns: ["id", "household_id"]
          },
          {
            foreignKeyName: "chain_aliases_household_id_fkey"
            columns: ["household_id"]
            isOneToOne: false
            referencedRelation: "households"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "chain_aliases_updated_by_profile_id_household_id_fkey"
            columns: ["updated_by_profile_id", "household_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id", "household_id"]
          },
        ]
      }
      chain_requirements: {
        Row: {
          archived_at: string | null
          chain_id: string
          created_at: string
          description: string
          household_id: string
          id: string
          kind: string
          label: string
          min_purchase_amount_yen: number | null
          min_purchase_count: number | null
          updated_at: string
          updated_by_profile_id: string | null
          valid_months: number | null
        }
        Insert: {
          archived_at?: string | null
          chain_id: string
          created_at?: string
          description?: string
          household_id: string
          id?: string
          kind: string
          label: string
          min_purchase_amount_yen?: number | null
          min_purchase_count?: number | null
          updated_at?: string
          updated_by_profile_id?: string | null
          valid_months?: number | null
        }
        Update: {
          archived_at?: string | null
          chain_id?: string
          created_at?: string
          description?: string
          household_id?: string
          id?: string
          kind?: string
          label?: string
          min_purchase_amount_yen?: number | null
          min_purchase_count?: number | null
          updated_at?: string
          updated_by_profile_id?: string | null
          valid_months?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "chain_requirements_chain_id_household_id_fkey"
            columns: ["chain_id", "household_id"]
            isOneToOne: false
            referencedRelation: "chains"
            referencedColumns: ["id", "household_id"]
          },
          {
            foreignKeyName: "chain_requirements_household_id_fkey"
            columns: ["household_id"]
            isOneToOne: false
            referencedRelation: "households"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "chain_requirements_updated_by_profile_id_household_id_fkey"
            columns: ["updated_by_profile_id", "household_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id", "household_id"]
          },
        ]
      }
      chains: {
        Row: {
          archived_at: string | null
          created_at: string
          default_application_rule: string
          household_id: string
          id: string
          is_provisional: boolean
          memo: string
          name: string
          updated_at: string
          updated_by_profile_id: string | null
        }
        Insert: {
          archived_at?: string | null
          created_at?: string
          default_application_rule?: string
          household_id: string
          id?: string
          is_provisional?: boolean
          memo?: string
          name: string
          updated_at?: string
          updated_by_profile_id?: string | null
        }
        Update: {
          archived_at?: string | null
          created_at?: string
          default_application_rule?: string
          household_id?: string
          id?: string
          is_provisional?: boolean
          memo?: string
          name?: string
          updated_at?: string
          updated_by_profile_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "chains_household_id_fkey"
            columns: ["household_id"]
            isOneToOne: false
            referencedRelation: "households"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "chains_updated_by_profile_id_household_id_fkey"
            columns: ["updated_by_profile_id", "household_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id", "household_id"]
          },
        ]
      }
      eligibility_purchases: {
        Row: {
          amount_yen: number | null
          archived_at: string | null
          counts_until: string | null
          created_at: string
          household_id: string
          id: string
          note: string
          purchased_on: string | null
          quantity: number | null
          service_account_id: string
          store_id: string | null
          updated_at: string
          updated_by_profile_id: string | null
        }
        Insert: {
          amount_yen?: number | null
          archived_at?: string | null
          counts_until?: string | null
          created_at?: string
          household_id: string
          id?: string
          note?: string
          purchased_on?: string | null
          quantity?: number | null
          service_account_id: string
          store_id?: string | null
          updated_at?: string
          updated_by_profile_id?: string | null
        }
        Update: {
          amount_yen?: number | null
          archived_at?: string | null
          counts_until?: string | null
          created_at?: string
          household_id?: string
          id?: string
          note?: string
          purchased_on?: string | null
          quantity?: number | null
          service_account_id?: string
          store_id?: string | null
          updated_at?: string
          updated_by_profile_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "eligibility_purchases_household_id_fkey"
            columns: ["household_id"]
            isOneToOne: false
            referencedRelation: "households"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "eligibility_purchases_service_account_id_household_id_fkey"
            columns: ["service_account_id", "household_id"]
            isOneToOne: false
            referencedRelation: "service_accounts"
            referencedColumns: ["id", "household_id"]
          },
          {
            foreignKeyName: "eligibility_purchases_store_id_household_id_fkey"
            columns: ["store_id", "household_id"]
            isOneToOne: false
            referencedRelation: "stores"
            referencedColumns: ["id", "household_id"]
          },
          {
            foreignKeyName: "eligibility_purchases_updated_by_profile_id_household_id_fkey"
            columns: ["updated_by_profile_id", "household_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id", "household_id"]
          },
        ]
      }
      family_groups: {
        Row: {
          archived_at: string | null
          created_at: string
          household_id: string
          id: string
          label: string
          updated_at: string
          updated_by_profile_id: string | null
        }
        Insert: {
          archived_at?: string | null
          created_at?: string
          household_id: string
          id?: string
          label: string
          updated_at?: string
          updated_by_profile_id?: string | null
        }
        Update: {
          archived_at?: string | null
          created_at?: string
          household_id?: string
          id?: string
          label?: string
          updated_at?: string
          updated_by_profile_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "family_groups_household_id_fkey"
            columns: ["household_id"]
            isOneToOne: false
            referencedRelation: "households"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "family_groups_updated_by_profile_id_household_id_fkey"
            columns: ["updated_by_profile_id", "household_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id", "household_id"]
          },
        ]
      }
      household_members: {
        Row: {
          created_at: string
          household_id: string
          user_id: string
        }
        Insert: {
          created_at?: string
          household_id: string
          user_id: string
        }
        Update: {
          created_at?: string
          household_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "household_members_household_id_fkey"
            columns: ["household_id"]
            isOneToOne: false
            referencedRelation: "households"
            referencedColumns: ["id"]
          },
        ]
      }
      household_settings: {
        Row: {
          ai_monthly_budget_jpy: number
          auto_ai_enabled: boolean
          card_display: Json
          distance_bands_km: Json
          home_address: string | null
          home_lat: number | null
          home_lng: number | null
          household_id: string
          travel_review_needed: boolean
          updated_at: string
          updated_by_profile_id: string | null
        }
        Insert: {
          ai_monthly_budget_jpy?: number
          auto_ai_enabled?: boolean
          card_display?: Json
          distance_bands_km?: Json
          home_address?: string | null
          home_lat?: number | null
          home_lng?: number | null
          household_id: string
          travel_review_needed?: boolean
          updated_at?: string
          updated_by_profile_id?: string | null
        }
        Update: {
          ai_monthly_budget_jpy?: number
          auto_ai_enabled?: boolean
          card_display?: Json
          distance_bands_km?: Json
          home_address?: string | null
          home_lat?: number | null
          home_lng?: number | null
          household_id?: string
          travel_review_needed?: boolean
          updated_at?: string
          updated_by_profile_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "household_settings_household_id_fkey"
            columns: ["household_id"]
            isOneToOne: true
            referencedRelation: "households"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "household_settings_updated_by_profile_id_household_id_fkey"
            columns: ["updated_by_profile_id", "household_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id", "household_id"]
          },
        ]
      }
      households: {
        Row: {
          created_at: string
          id: string
          name: string
          owner_auth_user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          name?: string
          owner_auth_user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          name?: string
          owner_auth_user_id?: string
        }
        Relationships: []
      }
      identities: {
        Row: {
          address_group_id: string
          archived_at: string | null
          created_at: string
          display_label: string
          family_group_id: string
          household_id: string
          id: string
          updated_at: string
          updated_by_profile_id: string | null
        }
        Insert: {
          address_group_id: string
          archived_at?: string | null
          created_at?: string
          display_label: string
          family_group_id: string
          household_id: string
          id?: string
          updated_at?: string
          updated_by_profile_id?: string | null
        }
        Update: {
          address_group_id?: string
          archived_at?: string | null
          created_at?: string
          display_label?: string
          family_group_id?: string
          household_id?: string
          id?: string
          updated_at?: string
          updated_by_profile_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "identities_address_group_id_household_id_fkey"
            columns: ["address_group_id", "household_id"]
            isOneToOne: false
            referencedRelation: "address_groups"
            referencedColumns: ["id", "household_id"]
          },
          {
            foreignKeyName: "identities_family_group_id_household_id_fkey"
            columns: ["family_group_id", "household_id"]
            isOneToOne: false
            referencedRelation: "family_groups"
            referencedColumns: ["id", "household_id"]
          },
          {
            foreignKeyName: "identities_household_id_fkey"
            columns: ["household_id"]
            isOneToOne: false
            referencedRelation: "households"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "identities_updated_by_profile_id_household_id_fkey"
            columns: ["updated_by_profile_id", "household_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id", "household_id"]
          },
        ]
      }
      limit_exemptions: {
        Row: {
          created_at: string
          household_id: string
          id: string
          lottery_id: string
          reason: string
          service_account_id: string
          updated_at: string
          updated_by_profile_id: string | null
        }
        Insert: {
          created_at?: string
          household_id: string
          id?: string
          lottery_id: string
          reason?: string
          service_account_id: string
          updated_at?: string
          updated_by_profile_id?: string | null
        }
        Update: {
          created_at?: string
          household_id?: string
          id?: string
          lottery_id?: string
          reason?: string
          service_account_id?: string
          updated_at?: string
          updated_by_profile_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "limit_exemptions_household_id_fkey"
            columns: ["household_id"]
            isOneToOne: false
            referencedRelation: "households"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "limit_exemptions_lottery_id_household_id_fkey"
            columns: ["lottery_id", "household_id"]
            isOneToOne: false
            referencedRelation: "lotteries"
            referencedColumns: ["id", "household_id"]
          },
          {
            foreignKeyName: "limit_exemptions_service_account_id_household_id_fkey"
            columns: ["service_account_id", "household_id"]
            isOneToOne: false
            referencedRelation: "service_accounts"
            referencedColumns: ["id", "household_id"]
          },
          {
            foreignKeyName: "limit_exemptions_updated_by_profile_id_household_id_fkey"
            columns: ["updated_by_profile_id", "household_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id", "household_id"]
          },
        ]
      }
      lotteries: {
        Row: {
          announcement_method: string
          announcement_url: string | null
          apply_deadline_at: string | null
          apply_deadline_date: string | null
          apply_deadline_precision: string
          apply_method: string
          apply_start_at: string | null
          apply_start_date: string | null
          apply_start_precision: string
          archived_at: string | null
          campaign_id: string | null
          chain_id: string
          conditions_text: string
          created_at: string
          event_state: string
          household_id: string
          id: string
          is_new: boolean
          limit_basis: string
          limit_max_count: number
          memo: string
          multi_mode: string
          procedure_deadline_at: string | null
          procedure_deadline_date: string | null
          procedure_deadline_precision: string
          procedure_start_at: string | null
          procedure_start_date: string | null
          procedure_start_precision: string
          receive_method: string
          result_at: string | null
          result_date: string | null
          result_end_date: string | null
          result_precision: string
          source_kind: string
          source_urls: string[]
          store_id: string
          unconfirmed_fields: string[]
          updated_at: string
          updated_by_profile_id: string | null
          verification_text: string
        }
        Insert: {
          announcement_method?: string
          announcement_url?: string | null
          apply_deadline_at?: string | null
          apply_deadline_date?: string | null
          apply_deadline_precision?: string
          apply_method?: string
          apply_start_at?: string | null
          apply_start_date?: string | null
          apply_start_precision?: string
          archived_at?: string | null
          campaign_id?: string | null
          chain_id: string
          conditions_text?: string
          created_at?: string
          event_state?: string
          household_id: string
          id?: string
          is_new?: boolean
          limit_basis?: string
          limit_max_count?: number
          memo?: string
          multi_mode?: string
          procedure_deadline_at?: string | null
          procedure_deadline_date?: string | null
          procedure_deadline_precision?: string
          procedure_start_at?: string | null
          procedure_start_date?: string | null
          procedure_start_precision?: string
          receive_method?: string
          result_at?: string | null
          result_date?: string | null
          result_end_date?: string | null
          result_precision?: string
          source_kind?: string
          source_urls?: string[]
          store_id: string
          unconfirmed_fields?: string[]
          updated_at?: string
          updated_by_profile_id?: string | null
          verification_text?: string
        }
        Update: {
          announcement_method?: string
          announcement_url?: string | null
          apply_deadline_at?: string | null
          apply_deadline_date?: string | null
          apply_deadline_precision?: string
          apply_method?: string
          apply_start_at?: string | null
          apply_start_date?: string | null
          apply_start_precision?: string
          archived_at?: string | null
          campaign_id?: string | null
          chain_id?: string
          conditions_text?: string
          created_at?: string
          event_state?: string
          household_id?: string
          id?: string
          is_new?: boolean
          limit_basis?: string
          limit_max_count?: number
          memo?: string
          multi_mode?: string
          procedure_deadline_at?: string | null
          procedure_deadline_date?: string | null
          procedure_deadline_precision?: string
          procedure_start_at?: string | null
          procedure_start_date?: string | null
          procedure_start_precision?: string
          receive_method?: string
          result_at?: string | null
          result_date?: string | null
          result_end_date?: string | null
          result_precision?: string
          source_kind?: string
          source_urls?: string[]
          store_id?: string
          unconfirmed_fields?: string[]
          updated_at?: string
          updated_by_profile_id?: string | null
          verification_text?: string
        }
        Relationships: [
          {
            foreignKeyName: "lotteries_campaign_id_household_id_fkey"
            columns: ["campaign_id", "household_id"]
            isOneToOne: false
            referencedRelation: "campaigns"
            referencedColumns: ["id", "household_id"]
          },
          {
            foreignKeyName: "lotteries_chain_id_household_id_fkey"
            columns: ["chain_id", "household_id"]
            isOneToOne: false
            referencedRelation: "chains"
            referencedColumns: ["id", "household_id"]
          },
          {
            foreignKeyName: "lotteries_household_id_fkey"
            columns: ["household_id"]
            isOneToOne: false
            referencedRelation: "households"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lotteries_store_id_household_id_fkey"
            columns: ["store_id", "household_id"]
            isOneToOne: false
            referencedRelation: "stores"
            referencedColumns: ["id", "household_id"]
          },
          {
            foreignKeyName: "lotteries_updated_by_profile_id_household_id_fkey"
            columns: ["updated_by_profile_id", "household_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id", "household_id"]
          },
        ]
      }
      lottery_items: {
        Row: {
          created_at: string
          household_id: string
          id: string
          lottery_id: string
          product_id: string
          quantity: number
          unit: string
          updated_at: string
          updated_by_profile_id: string | null
        }
        Insert: {
          created_at?: string
          household_id: string
          id?: string
          lottery_id: string
          product_id: string
          quantity: number
          unit: string
          updated_at?: string
          updated_by_profile_id?: string | null
        }
        Update: {
          created_at?: string
          household_id?: string
          id?: string
          lottery_id?: string
          product_id?: string
          quantity?: number
          unit?: string
          updated_at?: string
          updated_by_profile_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "lottery_items_household_id_fkey"
            columns: ["household_id"]
            isOneToOne: false
            referencedRelation: "households"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lottery_items_lottery_id_household_id_fkey"
            columns: ["lottery_id", "household_id"]
            isOneToOne: false
            referencedRelation: "lotteries"
            referencedColumns: ["id", "household_id"]
          },
          {
            foreignKeyName: "lottery_items_product_id_household_id_fkey"
            columns: ["product_id", "household_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id", "household_id"]
          },
          {
            foreignKeyName: "lottery_items_updated_by_profile_id_household_id_fkey"
            columns: ["updated_by_profile_id", "household_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id", "household_id"]
          },
        ]
      }
      lottery_management: {
        Row: {
          created_at: string
          household_id: string
          is_managed: boolean
          lottery_id: string
          managed_at: string | null
          managed_source: string
          reviewed_at: string | null
          updated_at: string
          updated_by_profile_id: string | null
        }
        Insert: {
          created_at?: string
          household_id: string
          is_managed?: boolean
          lottery_id: string
          managed_at?: string | null
          managed_source?: string
          reviewed_at?: string | null
          updated_at?: string
          updated_by_profile_id?: string | null
        }
        Update: {
          created_at?: string
          household_id?: string
          is_managed?: boolean
          lottery_id?: string
          managed_at?: string | null
          managed_source?: string
          reviewed_at?: string | null
          updated_at?: string
          updated_by_profile_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "lottery_management_household_id_fkey"
            columns: ["household_id"]
            isOneToOne: false
            referencedRelation: "households"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "lottery_management_lottery_id_household_id_fkey"
            columns: ["lottery_id", "household_id"]
            isOneToOne: false
            referencedRelation: "lotteries"
            referencedColumns: ["id", "household_id"]
          },
          {
            foreignKeyName: "lottery_management_updated_by_profile_id_household_id_fkey"
            columns: ["updated_by_profile_id", "household_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id", "household_id"]
          },
        ]
      }
      management_counters: {
        Row: {
          household_id: string
          kind: string
          last_value: number
        }
        Insert: {
          household_id: string
          kind: string
          last_value?: number
        }
        Update: {
          household_id?: string
          kind?: string
          last_value?: number
        }
        Relationships: [
          {
            foreignKeyName: "management_counters_household_id_fkey"
            columns: ["household_id"]
            isOneToOne: false
            referencedRelation: "households"
            referencedColumns: ["id"]
          },
        ]
      }
      master_import_history: {
        Row: {
          composition_count: number
          created_at: string
          created_count: number
          details: Json
          file_name: string
          file_sha256: string
          fingerprint: string
          household_id: string
          id: string
          imported_by_profile_id: string | null
          kind: string
          unchanged_count: number
          updated_count: number
        }
        Insert: {
          composition_count?: number
          created_at?: string
          created_count?: number
          details?: Json
          file_name: string
          file_sha256: string
          fingerprint: string
          household_id: string
          id?: string
          imported_by_profile_id?: string | null
          kind: string
          unchanged_count?: number
          updated_count?: number
        }
        Update: {
          composition_count?: number
          created_at?: string
          created_count?: number
          details?: Json
          file_name?: string
          file_sha256?: string
          fingerprint?: string
          household_id?: string
          id?: string
          imported_by_profile_id?: string | null
          kind?: string
          unchanged_count?: number
          updated_count?: number
        }
        Relationships: [
          {
            foreignKeyName: "master_import_history_household_id_fkey"
            columns: ["household_id"]
            isOneToOne: false
            referencedRelation: "households"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "master_import_history_imported_by_profile_id_household_id_fkey"
            columns: ["imported_by_profile_id", "household_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id", "household_id"]
          },
        ]
      }
      notification_cron_calls: {
        Row: {
          called_at: string
          error_msg: string | null
          harvested_at: string | null
          id: number
          request_id: number | null
          status_code: number | null
        }
        Insert: {
          called_at?: string
          error_msg?: string | null
          harvested_at?: string | null
          id?: never
          request_id?: number | null
          status_code?: number | null
        }
        Update: {
          called_at?: string
          error_msg?: string | null
          harvested_at?: string | null
          id?: never
          request_id?: number | null
          status_code?: number | null
        }
        Relationships: []
      }
      notification_deliveries: {
        Row: {
          application_id: string | null
          attempts: number
          created_at: string
          error_code: string | null
          household_id: string
          id: string
          lottery_id: string | null
          profile_id: string
          sent_at: string | null
          status: string
          trigger_key: string
          type: string
        }
        Insert: {
          application_id?: string | null
          attempts?: number
          created_at?: string
          error_code?: string | null
          household_id: string
          id?: string
          lottery_id?: string | null
          profile_id: string
          sent_at?: string | null
          status: string
          trigger_key: string
          type: string
        }
        Update: {
          application_id?: string | null
          attempts?: number
          created_at?: string
          error_code?: string | null
          household_id?: string
          id?: string
          lottery_id?: string | null
          profile_id?: string
          sent_at?: string | null
          status?: string
          trigger_key?: string
          type?: string
        }
        Relationships: [
          {
            foreignKeyName: "notification_deliveries_household_id_fkey"
            columns: ["household_id"]
            isOneToOne: false
            referencedRelation: "households"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notification_deliveries_profile_id_household_id_fkey"
            columns: ["profile_id", "household_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id", "household_id"]
          },
        ]
      }
      notification_job_runs: {
        Row: {
          duplicates: number | null
          duration_ms: number | null
          error_code: string | null
          failed: number | null
          finished_at: string | null
          id: string
          no_device: number | null
          planned: number | null
          sent: number | null
          started_at: string
          status: string
          suppressed: number | null
          trigger: string
        }
        Insert: {
          duplicates?: number | null
          duration_ms?: number | null
          error_code?: string | null
          failed?: number | null
          finished_at?: string | null
          id?: string
          no_device?: number | null
          planned?: number | null
          sent?: number | null
          started_at?: string
          status?: string
          suppressed?: number | null
          trigger?: string
        }
        Update: {
          duplicates?: number | null
          duration_ms?: number | null
          error_code?: string | null
          failed?: number | null
          finished_at?: string | null
          id?: string
          no_device?: number | null
          planned?: number | null
          sent?: number | null
          started_at?: string
          status?: string
          suppressed?: number | null
          trigger?: string
        }
        Relationships: []
      }
      notification_settings: {
        Row: {
          created_at: string
          date_only_policy: string
          deadline_offsets_min: number[]
          eligibility_expiry_days: number
          enabled: boolean
          household_id: string
          id: string
          morning_time: string
          procedure_enabled: boolean
          procedure_lead_hours: number[]
          profile_id: string
          result_enabled: boolean
          result_reminder_hours: number[]
          updated_at: string
          updated_by_profile_id: string | null
        }
        Insert: {
          created_at?: string
          date_only_policy?: string
          deadline_offsets_min?: number[]
          eligibility_expiry_days?: number
          enabled?: boolean
          household_id: string
          id?: string
          morning_time?: string
          procedure_enabled?: boolean
          procedure_lead_hours?: number[]
          profile_id: string
          result_enabled?: boolean
          result_reminder_hours?: number[]
          updated_at?: string
          updated_by_profile_id?: string | null
        }
        Update: {
          created_at?: string
          date_only_policy?: string
          deadline_offsets_min?: number[]
          eligibility_expiry_days?: number
          enabled?: boolean
          household_id?: string
          id?: string
          morning_time?: string
          procedure_enabled?: boolean
          procedure_lead_hours?: number[]
          profile_id?: string
          result_enabled?: boolean
          result_reminder_hours?: number[]
          updated_at?: string
          updated_by_profile_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "notification_settings_household_id_fkey"
            columns: ["household_id"]
            isOneToOne: false
            referencedRelation: "households"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notification_settings_profile_id_household_id_fkey"
            columns: ["profile_id", "household_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id", "household_id"]
          },
          {
            foreignKeyName: "notification_settings_updated_by_profile_id_household_id_fkey"
            columns: ["updated_by_profile_id", "household_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id", "household_id"]
          },
        ]
      }
      product_aliases: {
        Row: {
          alias: string
          created_at: string
          household_id: string
          id: string
          normalized_alias: string
          product_id: string
          updated_at: string
          updated_by_profile_id: string | null
        }
        Insert: {
          alias: string
          created_at?: string
          household_id: string
          id?: string
          normalized_alias: string
          product_id: string
          updated_at?: string
          updated_by_profile_id?: string | null
        }
        Update: {
          alias?: string
          created_at?: string
          household_id?: string
          id?: string
          normalized_alias?: string
          product_id?: string
          updated_at?: string
          updated_by_profile_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "product_aliases_household_id_fkey"
            columns: ["household_id"]
            isOneToOne: false
            referencedRelation: "households"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "product_aliases_product_id_household_id_fkey"
            columns: ["product_id", "household_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id", "household_id"]
          },
          {
            foreignKeyName: "product_aliases_updated_by_profile_id_household_id_fkey"
            columns: ["updated_by_profile_id", "household_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id", "household_id"]
          },
        ]
      }
      product_images: {
        Row: {
          content_box: Json | null
          created_at: string
          display_scale: number
          height: number | null
          household_id: string
          id: string
          kind: string
          offset_x: number
          offset_y: number
          product_id: string
          sha256: string
          source: string
          storage_path: string
          thumb_path: string | null
          updated_at: string
          updated_by_profile_id: string | null
          width: number | null
        }
        Insert: {
          content_box?: Json | null
          created_at?: string
          display_scale?: number
          height?: number | null
          household_id: string
          id?: string
          kind: string
          offset_x?: number
          offset_y?: number
          product_id: string
          sha256: string
          source?: string
          storage_path: string
          thumb_path?: string | null
          updated_at?: string
          updated_by_profile_id?: string | null
          width?: number | null
        }
        Update: {
          content_box?: Json | null
          created_at?: string
          display_scale?: number
          height?: number | null
          household_id?: string
          id?: string
          kind?: string
          offset_x?: number
          offset_y?: number
          product_id?: string
          sha256?: string
          source?: string
          storage_path?: string
          thumb_path?: string | null
          updated_at?: string
          updated_by_profile_id?: string | null
          width?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "product_images_household_id_fkey"
            columns: ["household_id"]
            isOneToOne: false
            referencedRelation: "households"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "product_images_product_id_household_id_fkey"
            columns: ["product_id", "household_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id", "household_id"]
          },
          {
            foreignKeyName: "product_images_updated_by_profile_id_household_id_fkey"
            columns: ["updated_by_profile_id", "household_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id", "household_id"]
          },
        ]
      }
      product_prices: {
        Row: {
          amount_yen: number
          created_at: string
          household_id: string
          id: string
          product_id: string
          unit: string
          updated_at: string
          updated_by_profile_id: string | null
          valid_from: string
          valid_to: string | null
        }
        Insert: {
          amount_yen: number
          created_at?: string
          household_id: string
          id?: string
          product_id: string
          unit: string
          updated_at?: string
          updated_by_profile_id?: string | null
          valid_from: string
          valid_to?: string | null
        }
        Update: {
          amount_yen?: number
          created_at?: string
          household_id?: string
          id?: string
          product_id?: string
          unit?: string
          updated_at?: string
          updated_by_profile_id?: string | null
          valid_from?: string
          valid_to?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "product_prices_household_id_fkey"
            columns: ["household_id"]
            isOneToOne: false
            referencedRelation: "households"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "product_prices_product_id_household_id_fkey"
            columns: ["product_id", "household_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id", "household_id"]
          },
          {
            foreignKeyName: "product_prices_updated_by_profile_id_household_id_fkey"
            columns: ["updated_by_profile_id", "household_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id", "household_id"]
          },
        ]
      }
      product_set_items: {
        Row: {
          component_product_id: string
          created_at: string
          household_id: string
          id: string
          quantity: number
          set_product_id: string
          updated_at: string
          updated_by_profile_id: string | null
        }
        Insert: {
          component_product_id: string
          created_at?: string
          household_id: string
          id?: string
          quantity?: number
          set_product_id: string
          updated_at?: string
          updated_by_profile_id?: string | null
        }
        Update: {
          component_product_id?: string
          created_at?: string
          household_id?: string
          id?: string
          quantity?: number
          set_product_id?: string
          updated_at?: string
          updated_by_profile_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "product_set_items_component_product_id_household_id_fkey"
            columns: ["component_product_id", "household_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id", "household_id"]
          },
          {
            foreignKeyName: "product_set_items_household_id_fkey"
            columns: ["household_id"]
            isOneToOne: false
            referencedRelation: "households"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "product_set_items_set_product_id_household_id_fkey"
            columns: ["set_product_id", "household_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id", "household_id"]
          },
          {
            foreignKeyName: "product_set_items_updated_by_profile_id_household_id_fkey"
            columns: ["updated_by_profile_id", "household_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id", "household_id"]
          },
        ]
      }
      products: {
        Row: {
          archived_at: string | null
          box_image_ref: string | null
          category: string
          created_at: string
          household_id: string
          id: string
          image_url: string | null
          is_provisional: boolean
          list_price_box: number | null
          list_price_pack: number | null
          list_price_unit: number | null
          management_no: string | null
          manual_override_fields: string[]
          memo: string | null
          official_name: string
          pack_image_ref: string | null
          packs_per_box: number | null
          product_code: string | null
          product_code_kind: string | null
          product_group: string | null
          release_date: string | null
          sales_form: string | null
          source_url: string | null
          updated_at: string
          updated_by_profile_id: string | null
        }
        Insert: {
          archived_at?: string | null
          box_image_ref?: string | null
          category?: string
          created_at?: string
          household_id: string
          id?: string
          image_url?: string | null
          is_provisional?: boolean
          list_price_box?: number | null
          list_price_pack?: number | null
          list_price_unit?: number | null
          management_no?: string | null
          manual_override_fields?: string[]
          memo?: string | null
          official_name: string
          pack_image_ref?: string | null
          packs_per_box?: number | null
          product_code?: string | null
          product_code_kind?: string | null
          product_group?: string | null
          release_date?: string | null
          sales_form?: string | null
          source_url?: string | null
          updated_at?: string
          updated_by_profile_id?: string | null
        }
        Update: {
          archived_at?: string | null
          box_image_ref?: string | null
          category?: string
          created_at?: string
          household_id?: string
          id?: string
          image_url?: string | null
          is_provisional?: boolean
          list_price_box?: number | null
          list_price_pack?: number | null
          list_price_unit?: number | null
          management_no?: string | null
          manual_override_fields?: string[]
          memo?: string | null
          official_name?: string
          pack_image_ref?: string | null
          packs_per_box?: number | null
          product_code?: string | null
          product_code_kind?: string | null
          product_group?: string | null
          release_date?: string | null
          sales_form?: string | null
          source_url?: string | null
          updated_at?: string
          updated_by_profile_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "products_household_id_fkey"
            columns: ["household_id"]
            isOneToOne: false
            referencedRelation: "households"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "products_updated_by_profile_id_household_id_fkey"
            columns: ["updated_by_profile_id", "household_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id", "household_id"]
          },
        ]
      }
      profile_settings: {
        Row: {
          created_at: string
          household_id: string
          profile_id: string
          settings: Json
          updated_at: string
          updated_by_profile_id: string | null
        }
        Insert: {
          created_at?: string
          household_id: string
          profile_id: string
          settings?: Json
          updated_at?: string
          updated_by_profile_id?: string | null
        }
        Update: {
          created_at?: string
          household_id?: string
          profile_id?: string
          settings?: Json
          updated_at?: string
          updated_by_profile_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "profile_settings_household_id_fkey"
            columns: ["household_id"]
            isOneToOne: false
            referencedRelation: "households"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "profile_settings_profile_id_household_id_fkey"
            columns: ["profile_id", "household_id"]
            isOneToOne: true
            referencedRelation: "profiles"
            referencedColumns: ["id", "household_id"]
          },
          {
            foreignKeyName: "profile_settings_updated_by_profile_id_household_id_fkey"
            columns: ["updated_by_profile_id", "household_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id", "household_id"]
          },
        ]
      }
      profile_target_rules: {
        Row: {
          chain_id: string
          created_at: string
          household_id: string
          id: string
          mode: string
          profile_id: string
          store_id: string | null
          updated_at: string
          updated_by_profile_id: string | null
        }
        Insert: {
          chain_id: string
          created_at?: string
          household_id: string
          id?: string
          mode: string
          profile_id: string
          store_id?: string | null
          updated_at?: string
          updated_by_profile_id?: string | null
        }
        Update: {
          chain_id?: string
          created_at?: string
          household_id?: string
          id?: string
          mode?: string
          profile_id?: string
          store_id?: string | null
          updated_at?: string
          updated_by_profile_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "profile_target_rules_chain_id_household_id_fkey"
            columns: ["chain_id", "household_id"]
            isOneToOne: false
            referencedRelation: "chains"
            referencedColumns: ["id", "household_id"]
          },
          {
            foreignKeyName: "profile_target_rules_household_id_fkey"
            columns: ["household_id"]
            isOneToOne: false
            referencedRelation: "households"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "profile_target_rules_profile_id_household_id_fkey"
            columns: ["profile_id", "household_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id", "household_id"]
          },
          {
            foreignKeyName: "profile_target_rules_store_fk"
            columns: ["store_id", "chain_id", "household_id"]
            isOneToOne: false
            referencedRelation: "stores"
            referencedColumns: ["id", "chain_id", "household_id"]
          },
          {
            foreignKeyName: "profile_target_rules_updated_by_profile_id_household_id_fkey"
            columns: ["updated_by_profile_id", "household_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id", "household_id"]
          },
        ]
      }
      profiles: {
        Row: {
          active: boolean
          color: string
          color_hex: string | null
          created_at: string
          household_id: string
          icon_mark: string
          id: string
          initial: string
          label: string
          notify_recipient_ids: string[] | null
          sort_order: number
          updated_at: string
          updated_by_profile_id: string | null
        }
        Insert: {
          active?: boolean
          color?: string
          color_hex?: string | null
          created_at?: string
          household_id: string
          icon_mark?: string
          id?: string
          initial: string
          label: string
          notify_recipient_ids?: string[] | null
          sort_order?: number
          updated_at?: string
          updated_by_profile_id?: string | null
        }
        Update: {
          active?: boolean
          color?: string
          color_hex?: string | null
          created_at?: string
          household_id?: string
          icon_mark?: string
          id?: string
          initial?: string
          label?: string
          notify_recipient_ids?: string[] | null
          sort_order?: number
          updated_at?: string
          updated_by_profile_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "profiles_household_id_fkey"
            columns: ["household_id"]
            isOneToOne: false
            referencedRelation: "households"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "profiles_updated_by_profile_id_household_id_fkey"
            columns: ["updated_by_profile_id", "household_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id", "household_id"]
          },
        ]
      }
      purchase_items: {
        Row: {
          amount_paid: number | null
          created_at: string
          household_id: string
          id: string
          lottery_item_id: string | null
          product_id: string | null
          product_label: string | null
          purchase_id: string
          quantity: number
          unit: string
          updated_at: string
          updated_by_profile_id: string | null
        }
        Insert: {
          amount_paid?: number | null
          created_at?: string
          household_id: string
          id?: string
          lottery_item_id?: string | null
          product_id?: string | null
          product_label?: string | null
          purchase_id: string
          quantity: number
          unit: string
          updated_at?: string
          updated_by_profile_id?: string | null
        }
        Update: {
          amount_paid?: number | null
          created_at?: string
          household_id?: string
          id?: string
          lottery_item_id?: string | null
          product_id?: string | null
          product_label?: string | null
          purchase_id?: string
          quantity?: number
          unit?: string
          updated_at?: string
          updated_by_profile_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "purchase_items_household_id_fkey"
            columns: ["household_id"]
            isOneToOne: false
            referencedRelation: "households"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "purchase_items_lottery_item_id_household_id_fkey"
            columns: ["lottery_item_id", "household_id"]
            isOneToOne: false
            referencedRelation: "lottery_items"
            referencedColumns: ["id", "household_id"]
          },
          {
            foreignKeyName: "purchase_items_product_id_household_id_fkey"
            columns: ["product_id", "household_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id", "household_id"]
          },
          {
            foreignKeyName: "purchase_items_purchase_id_household_id_fkey"
            columns: ["purchase_id", "household_id"]
            isOneToOne: false
            referencedRelation: "purchases"
            referencedColumns: ["id", "household_id"]
          },
          {
            foreignKeyName: "purchase_items_updated_by_profile_id_household_id_fkey"
            columns: ["updated_by_profile_id", "household_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id", "household_id"]
          },
        ]
      }
      purchases: {
        Row: {
          application_id: string | null
          archived_at: string | null
          buyer_profile_id: string | null
          channel: string
          created_at: string
          household_id: string
          id: string
          note: string
          purchased_at: string | null
          purchased_date: string | null
          record_kind: string
          source_kind: string
          store_id: string | null
          store_label: string | null
          updated_at: string
          updated_by_profile_id: string | null
        }
        Insert: {
          application_id?: string | null
          archived_at?: string | null
          buyer_profile_id?: string | null
          channel?: string
          created_at?: string
          household_id: string
          id?: string
          note?: string
          purchased_at?: string | null
          purchased_date?: string | null
          record_kind?: string
          source_kind?: string
          store_id?: string | null
          store_label?: string | null
          updated_at?: string
          updated_by_profile_id?: string | null
        }
        Update: {
          application_id?: string | null
          archived_at?: string | null
          buyer_profile_id?: string | null
          channel?: string
          created_at?: string
          household_id?: string
          id?: string
          note?: string
          purchased_at?: string | null
          purchased_date?: string | null
          record_kind?: string
          source_kind?: string
          store_id?: string | null
          store_label?: string | null
          updated_at?: string
          updated_by_profile_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "purchases_application_id_household_id_fkey"
            columns: ["application_id", "household_id"]
            isOneToOne: false
            referencedRelation: "applications"
            referencedColumns: ["id", "household_id"]
          },
          {
            foreignKeyName: "purchases_buyer_profile_id_household_id_fkey"
            columns: ["buyer_profile_id", "household_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id", "household_id"]
          },
          {
            foreignKeyName: "purchases_household_id_fkey"
            columns: ["household_id"]
            isOneToOne: false
            referencedRelation: "households"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "purchases_store_id_household_id_fkey"
            columns: ["store_id", "household_id"]
            isOneToOne: false
            referencedRelation: "stores"
            referencedColumns: ["id", "household_id"]
          },
          {
            foreignKeyName: "purchases_updated_by_profile_id_household_id_fkey"
            columns: ["updated_by_profile_id", "household_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id", "household_id"]
          },
        ]
      }
      push_subscriptions: {
        Row: {
          auth: string
          created_at: string
          device_label: string
          enabled: boolean
          endpoint: string
          failure_count: number
          household_id: string
          id: string
          last_seen_at: string
          p256dh: string
          profile_id: string
          updated_at: string
        }
        Insert: {
          auth: string
          created_at?: string
          device_label?: string
          enabled?: boolean
          endpoint: string
          failure_count?: number
          household_id: string
          id?: string
          last_seen_at?: string
          p256dh: string
          profile_id: string
          updated_at?: string
        }
        Update: {
          auth?: string
          created_at?: string
          device_label?: string
          enabled?: boolean
          endpoint?: string
          failure_count?: number
          household_id?: string
          id?: string
          last_seen_at?: string
          p256dh?: string
          profile_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "push_subscriptions_household_id_fkey"
            columns: ["household_id"]
            isOneToOne: false
            referencedRelation: "households"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "push_subscriptions_profile_id_household_id_fkey"
            columns: ["profile_id", "household_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id", "household_id"]
          },
        ]
      }
      sales: {
        Row: {
          amount: number
          archived_at: string | null
          cost_amount: number | null
          cost_purchase_item_id: string | null
          cost_quantity: number | null
          created_at: string
          fee: number
          household_id: string
          id: string
          memo: string
          platform: string
          product_id: string | null
          product_label: string | null
          quantity: number
          seller_profile_id: string
          shipping: number
          sold_on: string
          unit: string
          updated_at: string
          updated_by_profile_id: string | null
        }
        Insert: {
          amount: number
          archived_at?: string | null
          cost_amount?: number | null
          cost_purchase_item_id?: string | null
          cost_quantity?: number | null
          created_at?: string
          fee?: number
          household_id: string
          id?: string
          memo?: string
          platform?: string
          product_id?: string | null
          product_label?: string | null
          quantity: number
          seller_profile_id: string
          shipping?: number
          sold_on: string
          unit?: string
          updated_at?: string
          updated_by_profile_id?: string | null
        }
        Update: {
          amount?: number
          archived_at?: string | null
          cost_amount?: number | null
          cost_purchase_item_id?: string | null
          cost_quantity?: number | null
          created_at?: string
          fee?: number
          household_id?: string
          id?: string
          memo?: string
          platform?: string
          product_id?: string | null
          product_label?: string | null
          quantity?: number
          seller_profile_id?: string
          shipping?: number
          sold_on?: string
          unit?: string
          updated_at?: string
          updated_by_profile_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "sales_cost_purchase_item_id_household_id_fkey"
            columns: ["cost_purchase_item_id", "household_id"]
            isOneToOne: false
            referencedRelation: "purchase_items"
            referencedColumns: ["id", "household_id"]
          },
          {
            foreignKeyName: "sales_household_id_fkey"
            columns: ["household_id"]
            isOneToOne: false
            referencedRelation: "households"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sales_product_id_household_id_fkey"
            columns: ["product_id", "household_id"]
            isOneToOne: false
            referencedRelation: "products"
            referencedColumns: ["id", "household_id"]
          },
          {
            foreignKeyName: "sales_seller_profile_id_household_id_fkey"
            columns: ["seller_profile_id", "household_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id", "household_id"]
          },
          {
            foreignKeyName: "sales_updated_by_profile_id_household_id_fkey"
            columns: ["updated_by_profile_id", "household_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id", "household_id"]
          },
        ]
      }
      service_accounts: {
        Row: {
          account_label: string
          active: boolean
          chain_id: string
          created_at: string
          household_id: string
          id: string
          identity_id: string
          managed_by_profile_id: string
          membership_state: string
          updated_at: string
          updated_by_profile_id: string | null
        }
        Insert: {
          account_label: string
          active?: boolean
          chain_id: string
          created_at?: string
          household_id: string
          id?: string
          identity_id: string
          managed_by_profile_id: string
          membership_state?: string
          updated_at?: string
          updated_by_profile_id?: string | null
        }
        Update: {
          account_label?: string
          active?: boolean
          chain_id?: string
          created_at?: string
          household_id?: string
          id?: string
          identity_id?: string
          managed_by_profile_id?: string
          membership_state?: string
          updated_at?: string
          updated_by_profile_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "service_accounts_chain_id_household_id_fkey"
            columns: ["chain_id", "household_id"]
            isOneToOne: false
            referencedRelation: "chains"
            referencedColumns: ["id", "household_id"]
          },
          {
            foreignKeyName: "service_accounts_household_id_fkey"
            columns: ["household_id"]
            isOneToOne: false
            referencedRelation: "households"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "service_accounts_identity_id_household_id_fkey"
            columns: ["identity_id", "household_id"]
            isOneToOne: false
            referencedRelation: "identities"
            referencedColumns: ["id", "household_id"]
          },
          {
            foreignKeyName: "service_accounts_managed_by_profile_id_household_id_fkey"
            columns: ["managed_by_profile_id", "household_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id", "household_id"]
          },
          {
            foreignKeyName: "service_accounts_updated_by_profile_id_household_id_fkey"
            columns: ["updated_by_profile_id", "household_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id", "household_id"]
          },
        ]
      }
      skip_rule_exceptions: {
        Row: {
          created_at: string
          household_id: string
          id: string
          lottery_id: string
          skip_rule_id: string
          updated_at: string
          updated_by_profile_id: string | null
        }
        Insert: {
          created_at?: string
          household_id: string
          id?: string
          lottery_id: string
          skip_rule_id: string
          updated_at?: string
          updated_by_profile_id?: string | null
        }
        Update: {
          created_at?: string
          household_id?: string
          id?: string
          lottery_id?: string
          skip_rule_id?: string
          updated_at?: string
          updated_by_profile_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "skip_rule_exceptions_household_id_fkey"
            columns: ["household_id"]
            isOneToOne: false
            referencedRelation: "households"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "skip_rule_exceptions_lottery_id_household_id_fkey"
            columns: ["lottery_id", "household_id"]
            isOneToOne: false
            referencedRelation: "lotteries"
            referencedColumns: ["id", "household_id"]
          },
          {
            foreignKeyName: "skip_rule_exceptions_skip_rule_id_household_id_fkey"
            columns: ["skip_rule_id", "household_id"]
            isOneToOne: false
            referencedRelation: "skip_rules"
            referencedColumns: ["id", "household_id"]
          },
          {
            foreignKeyName: "skip_rule_exceptions_updated_by_profile_id_household_id_fkey"
            columns: ["updated_by_profile_id", "household_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id", "household_id"]
          },
        ]
      }
      skip_rules: {
        Row: {
          chain_id: string | null
          created_at: string
          household_id: string
          id: string
          lottery_id: string | null
          profile_id: string
          scope_type: string
          store_id: string | null
          updated_at: string
          updated_by_profile_id: string | null
        }
        Insert: {
          chain_id?: string | null
          created_at?: string
          household_id: string
          id?: string
          lottery_id?: string | null
          profile_id: string
          scope_type: string
          store_id?: string | null
          updated_at?: string
          updated_by_profile_id?: string | null
        }
        Update: {
          chain_id?: string | null
          created_at?: string
          household_id?: string
          id?: string
          lottery_id?: string | null
          profile_id?: string
          scope_type?: string
          store_id?: string | null
          updated_at?: string
          updated_by_profile_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "skip_rules_chain_id_household_id_fkey"
            columns: ["chain_id", "household_id"]
            isOneToOne: false
            referencedRelation: "chains"
            referencedColumns: ["id", "household_id"]
          },
          {
            foreignKeyName: "skip_rules_household_id_fkey"
            columns: ["household_id"]
            isOneToOne: false
            referencedRelation: "households"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "skip_rules_lottery_id_household_id_fkey"
            columns: ["lottery_id", "household_id"]
            isOneToOne: false
            referencedRelation: "lotteries"
            referencedColumns: ["id", "household_id"]
          },
          {
            foreignKeyName: "skip_rules_profile_id_household_id_fkey"
            columns: ["profile_id", "household_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id", "household_id"]
          },
          {
            foreignKeyName: "skip_rules_store_id_household_id_fkey"
            columns: ["store_id", "household_id"]
            isOneToOne: false
            referencedRelation: "stores"
            referencedColumns: ["id", "household_id"]
          },
          {
            foreignKeyName: "skip_rules_updated_by_profile_id_household_id_fkey"
            columns: ["updated_by_profile_id", "household_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id", "household_id"]
          },
        ]
      }
      store_aliases: {
        Row: {
          alias: string
          created_at: string
          household_id: string
          id: string
          normalized_alias: string
          store_id: string
          updated_at: string
          updated_by_profile_id: string | null
        }
        Insert: {
          alias: string
          created_at?: string
          household_id: string
          id?: string
          normalized_alias: string
          store_id: string
          updated_at?: string
          updated_by_profile_id?: string | null
        }
        Update: {
          alias?: string
          created_at?: string
          household_id?: string
          id?: string
          normalized_alias?: string
          store_id?: string
          updated_at?: string
          updated_by_profile_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "store_aliases_household_id_fkey"
            columns: ["household_id"]
            isOneToOne: false
            referencedRelation: "households"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "store_aliases_store_id_household_id_fkey"
            columns: ["store_id", "household_id"]
            isOneToOne: false
            referencedRelation: "stores"
            referencedColumns: ["id", "household_id"]
          },
          {
            foreignKeyName: "store_aliases_updated_by_profile_id_household_id_fkey"
            columns: ["updated_by_profile_id", "household_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id", "household_id"]
          },
        ]
      }
      stores: {
        Row: {
          address_optional: string
          apply_method: string | null
          archived_at: string | null
          chain_id: string
          created_at: string
          household_id: string
          id: string
          is_provisional: boolean
          latitude: number | null
          location_review_needed: boolean
          longitude: number | null
          management_no: string | null
          memo: string
          name: string
          nearest_station: string
          parking_memo: string
          prefecture: string
          receive_method: string | null
          round_trip_fare: number | null
          store_url: string | null
          updated_at: string
          updated_by_profile_id: string | null
        }
        Insert: {
          address_optional?: string
          apply_method?: string | null
          archived_at?: string | null
          chain_id: string
          created_at?: string
          household_id: string
          id?: string
          is_provisional?: boolean
          latitude?: number | null
          location_review_needed?: boolean
          longitude?: number | null
          management_no?: string | null
          memo?: string
          name: string
          nearest_station?: string
          parking_memo?: string
          prefecture?: string
          receive_method?: string | null
          round_trip_fare?: number | null
          store_url?: string | null
          updated_at?: string
          updated_by_profile_id?: string | null
        }
        Update: {
          address_optional?: string
          apply_method?: string | null
          archived_at?: string | null
          chain_id?: string
          created_at?: string
          household_id?: string
          id?: string
          is_provisional?: boolean
          latitude?: number | null
          location_review_needed?: boolean
          longitude?: number | null
          management_no?: string | null
          memo?: string
          name?: string
          nearest_station?: string
          parking_memo?: string
          prefecture?: string
          receive_method?: string | null
          round_trip_fare?: number | null
          store_url?: string | null
          updated_at?: string
          updated_by_profile_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "stores_chain_id_household_id_fkey"
            columns: ["chain_id", "household_id"]
            isOneToOne: false
            referencedRelation: "chains"
            referencedColumns: ["id", "household_id"]
          },
          {
            foreignKeyName: "stores_household_id_fkey"
            columns: ["household_id"]
            isOneToOne: false
            referencedRelation: "households"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stores_updated_by_profile_id_household_id_fkey"
            columns: ["updated_by_profile_id", "household_id"]
            isOneToOne: false
            referencedRelation: "profiles"
            referencedColumns: ["id", "household_id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      ack_travel_review: { Args: { p_actor: string }; Returns: undefined }
      apply_master_import: {
        Args: {
          p_actor: string
          p_file_name: string
          p_file_sha: string
          p_fingerprint: string
          p_kind: string
          p_ops: Json
          p_unchanged: number
        }
        Returns: Json
      }
      bootstrap_household: { Args: never; Returns: string }
      claim_ai_job_items: {
        Args: { p_lease_secs?: number; p_limit: number }
        Returns: {
          attempts: number
          created_at: string
          dedupe_key: string | null
          error_code: string | null
          error_message: string | null
          finished_at: string | null
          household_id: string
          id: string
          image_paths: string[]
          job_id: string
          lease_until: string | null
          lottery_id: string | null
          position: number
          result: Json | null
          run_id: string | null
          source_kind: string
          source_text: string | null
          source_url: string | null
          started_at: string | null
          status: string
          updated_at: string
        }[]
        SetofOptions: {
          from: "*"
          to: "ai_job_items"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      copy_profile_settings: {
        Args: {
          p_actor: string
          p_from: string
          p_keys: string[]
          p_to: string
        }
        Returns: undefined
      }
      current_household_id: { Args: never; Returns: string }
      ensure_profile_accounts: { Args: never; Returns: number }
      flex_ok: { Args: { d: string; p: string; t: string }; Returns: boolean }
      get_home_address: { Args: never; Returns: string }
      invoke_notify_job: {
        Args: { p_secret?: string; p_url?: string }
        Returns: number
      }
      is_household_member: { Args: { hid: string }; Returns: boolean }
      is_test_household: { Args: { hid: string }; Returns: boolean }
      log_settings_change: {
        Args: { p_actor: string; p_changed: string[]; p_household: string }
        Returns: undefined
      }
      mark_job_item_saved: {
        Args: { p_item: string; p_lottery: string }
        Returns: boolean
      }
      mark_purchased: {
        Args: { p_actor: string; p_application_id: string }
        Returns: undefined
      }
      next_management_no: {
        Args: { p_household: string; p_kind: string }
        Returns: string
      }
      norm_name: { Args: { s: string }; Returns: string }
      notification_cron_disable: { Args: never; Returns: boolean }
      notification_cron_enable: {
        Args: { p_schedule?: string }
        Returns: number
      }
      notification_job_status: {
        Args: never
        Returns: {
          last_run_at: string
          last_status: string
          last_success_at: string
          scheduled: boolean
        }[]
      }
      purge_test_households: {
        Args: never
        Returns: {
          owner_email: string
          purged_household: string
        }[]
      }
      push_subscription_status: {
        Args: { p_endpoint: string }
        Returns: {
          enabled: boolean
          profile_id: string
        }[]
      }
      rebind_push_subscription: {
        Args: { p_endpoint: string; p_profile: string }
        Returns: boolean
      }
      refresh_ai_job: { Args: { p_job: string }; Returns: string }
      register_push_subscription: {
        Args: {
          p_auth: string
          p_endpoint: string
          p_label: string
          p_p256dh: string
          p_profile: string
        }
        Returns: undefined
      }
      remove_push_subscription: {
        Args: { p_endpoint: string }
        Returns: undefined
      }
      save_card_with_holding: {
        Args: { p: Json; p_actor: string }
        Returns: string
      }
      save_home_location: {
        Args: {
          p_actor: string
          p_address: string
          p_lat: number
          p_lng: number
        }
        Returns: undefined
      }
      save_household_settings: {
        Args: {
          p_actor: string
          p_auto_ai: boolean
          p_bands: Json
          p_budget: number
          p_card_display: Json
        }
        Returns: undefined
      }
      save_lottery_tx: { Args: { p: Json; p_actor: string }; Returns: string }
      set_item_results: {
        Args: { p_actor: string; p_application_id: string; p_results: Json }
        Returns: undefined
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {},
  },
} as const
